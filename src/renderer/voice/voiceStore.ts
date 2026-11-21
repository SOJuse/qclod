import { useMemo, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import type { TabId } from '../../shared/types'
import {
  VOICE_MODEL_INFO,
  voiceErrorText,
  type VoiceControls,
  type VoiceErrorCode,
  type VoiceEvent,
  type VoiceMenuItem,
  type VoiceModelId,
  type VoiceModelsSnapshot
} from '../../shared/voice'
import { formatSizeRu } from '../../shared/format'
import { useAppStore } from '../state/useAppStore'
import { HoldToTalk } from './holdToTalk'
import { insertDictated } from './insertDictated'
import { micErrorFrom, startMic, type MicCapture } from './micCapture'
import { voicePlatform } from './platform'

/** Where a session's phrases go: the chat's draft, or the draft of the subagent opened over it (этап 4). */
export interface VoiceField {
  tabId: TabId
  /** `${tabId}:${agentId}` — the key of `agentDrafts`; null — the chat's own draft. */
  agentKey: string | null
}

export interface VoiceSession {
  /** null until main has answered `begin`. */
  id: string | null
  tabId: TabId
  field: VoiceField
  phase: 'starting' | 'loading' | 'listening' | 'stopping'
  /** Said in the title until the session ends (gpu-fallback). */
  note: string | null
}

export interface VoiceState {
  /** One session a window. */
  session: VoiceSession | null
  /** Sessions stopped but not yet `done`: their last phrases still come, to their own field. */
  ending: Record<string, VoiceField>
  /** The grey text of the phrase being said, with the session and the field it belongs to. */
  tentative: { session: string; fieldKey: string; text: string } | null
  /** The last error, in the tab it happened in; cleared by the next press. */
  error: { tabId: TabId; code: VoiceErrorCode } | null
  models: VoiceModelsSnapshot | null
  /** Where the caret stands, by field key: the tab id, or the agentDrafts key. */
  caretByField: Record<string, number>
  /** Where the caret goes after a phrase went in, by field key. */
  insertByField: Record<string, { at: number; rev: number }>
  /** The tab whose microphone button has its menu open. */
  menuTab: TabId | null
}

/** What the window gives the voice beyond the store: set by useVoiceHotkey. */
export interface VoiceHooks {
  openSettings(): void
  focusField(): void
}

const HOLD_MS = 400
const EARLY_LIMIT = 50

export const useVoice = create<VoiceState>(() => ({
  session: null,
  ending: {},
  tentative: null,
  error: null,
  models: null,
  caretByField: {},
  insertByField: {},
  menuTab: null
}))

let hold = new HoldToTalk(HOLD_MS)
let mic: MicCapture | null = null
let hooks: VoiceHooks = { openSettings: () => {}, focusField: () => {} }
/** Events of a session whose `begin` has not answered yet (main says loading/ready before it does). */
let early: VoiceEvent[] = []

export function setVoiceHooks(next: VoiceHooks): void {
  hooks = next
}

/** Back to a fresh window: for tests. */
export function resetVoice(): void {
  mic?.stop()
  mic = null
  hold = new HoldToTalk(HOLD_MS)
  early = []
  useVoice.setState(useVoice.getInitialState(), true)
}

// ------------------------------------------------------------------ fields

export function fieldKey(f: VoiceField): string {
  return f.agentKey ?? f.tabId
}

/** The input the tab's pane shows now: a subagent's, if one is opened over its ribbon (ChatPane's agentCard). */
export function fieldOf(tabId: TabId): VoiceField {
  const app = useAppStore.getState()
  const layer = app.layerByTab[tabId]
  const agentId = layer?.kind === 'agents' ? layer.agentId : undefined
  if (agentId !== undefined) {
    const card = (app.ribbonByTab[tabId] ?? []).some((i) => i.kind === 'subagent' && i.id === agentId)
    if (card) return { tabId, agentKey: `${tabId}:${agentId}` }
  }
  return { tabId, agentKey: null }
}

function draftOf(f: VoiceField): string {
  const app = useAppStore.getState()
  return (f.agentKey === null ? app.draftByTab[f.tabId] : app.agentDrafts[f.agentKey]) ?? ''
}

function writeDraft(f: VoiceField, text: string): void {
  const app = useAppStore.getState()
  if (f.agentKey === null) app.setDraft(f.tabId, text)
  else app.setAgentDraft(f.agentKey, text)
}

// ------------------------------------------------------------------ models

function selectedModel(): VoiceModelId {
  return useAppStore.getState().settings?.voice?.model ?? 'gigaam-v3'
}

/** The size the menu and the title name: what the model's download weighs. */
function modelSize(id: VoiceModelId): string {
  return formatSizeRu(VOICE_MODEL_INFO[id].downloadBytes)
}

/** The selected model, unless it is ready (or nothing is known yet). */
function missingModel(s: VoiceState): { id: VoiceModelId; progress?: number } | null {
  if (s.models === null) return null
  const id = selectedModel()
  const view = s.models.models.find((m) => m.id === id)
  if (!view || view.state.kind === 'ready') return null
  const st = view.state
  if (st.kind === 'downloading') return { id, progress: st.total > 0 ? st.done / st.total : 0 }
  if (st.kind === 'verifying' || st.kind === 'extracting') return { id, progress: 1 }
  return { id }
}

/** Asks main for the models and the microphone again («Голос» on open). */
export async function refreshModels(): Promise<void> {
  try {
    const models = await window.qclod.voice.models()
    useVoice.setState({ models })
  } catch {
    // The next change of the models says it again.
  }
}

function download(id: VoiceModelId): void {
  // A failure is in the model's state, with its words (ModelStore).
  void window.qclod.voice.download(id).catch(() => {})
}

// ---------------------------------------------------------------- sessions

function isRecording(s: VoiceState, tabId: TabId): boolean {
  return s.session !== null && s.session.tabId === tabId && s.session.phase !== 'stopping'
}

function stopMic(): void {
  mic?.stop()
  mic = null
}

/** Ends the window's session: the microphone goes now, the last phrase still comes. */
export function stopVoice(): void {
  const s = useVoice.getState().session
  if (s === null) return
  stopMic()
  hold.blur()
  if (s.id === null) {
    // `begin` has not answered: it ends itself when it does (see begin).
    useVoice.setState({ session: null })
    return
  }
  const id = s.id
  useVoice.setState((st) => ({ session: null, ending: { ...st.ending, [id]: s.field } }))
  void window.qclod.voice.end(id).catch(() => {})
}

function fail(tabId: TabId, code: VoiceErrorCode): void {
  useVoice.setState((st) => ({
    session: st.session?.tabId === tabId ? null : st.session,
    error: { tabId, code },
    tentative: null
  }))
}

async function begin(tabId: TabId): Promise<void> {
  if (useVoice.getState().session !== null) stopVoice()
  const mine: VoiceSession = { id: null, tabId, field: fieldOf(tabId), phase: 'starting', note: null }
  early = []
  useVoice.setState({ session: mine, error: null, menuTab: null })
  const current = (): boolean => useVoice.getState().session === mine

  let answer: Awaited<ReturnType<typeof window.qclod.voice.begin>>
  try {
    answer = await window.qclod.voice.begin(tabId)
  } catch {
    if (current()) fail(tabId, 'engine-crashed')
    return
  }
  if ('error' in answer) {
    if (current()) fail(tabId, answer.error)
    // The model went (deleted elsewhere): the button asks for it again.
    if (answer.error === 'no-model') void refreshModels()
    return
  }
  const id = answer.session
  if (!current()) {
    // Stopped before main answered: the session ends at once, and its texts are not wanted.
    void window.qclod.voice.end(id).catch(() => {})
    return
  }
  const started: VoiceSession = { ...mine, id, phase: 'listening' }
  useVoice.setState({ session: started })
  const missed = early.filter((e) => e.session === id)
  early = []
  for (const e of missed) onVoiceEvent(e)

  try {
    const capture = await startMic({
      onChunk: (pcm) => window.qclod.voice.audio(id, pcm),
      onLevel: () => {},
      onEnded: () => {
        // Unplugged: what was said stays, the session ends with its last phrase.
        if (useVoice.getState().session?.id !== id) return
        stopVoice()
        useVoice.setState({ error: { tabId, code: 'mic-lost' } })
      }
    })
    if (useVoice.getState().session?.id !== id) {
      capture.stop()
      return
    }
    mic = capture
  } catch (err) {
    if (useVoice.getState().session?.id !== id) return
    useVoice.setState({ session: null })
    void window.qclod.voice.end(id).catch(() => {})
    fail(tabId, micErrorFrom(err))
  }
}

/** What main says about a session. Another window's or a forgotten session's events are dropped. */
export function onVoiceEvent(e: VoiceEvent): void {
  const st = useVoice.getState()
  const current = st.session !== null && st.session.id === e.session ? st.session : null
  const endingField = st.ending[e.session]
  if (current === null && endingField === undefined) {
    if (st.session !== null && st.session.id === null && early.length < EARLY_LIMIT) early.push(e)
    return
  }
  const field = current?.field ?? endingField!
  switch (e.kind) {
    case 'loading':
      if (current) useVoice.setState({ session: { ...current, phase: 'loading' } })
      return
    case 'ready':
      if (current) useVoice.setState({ session: { ...current, phase: 'listening' } })
      return
    case 'partial':
      useVoice.setState({ tentative: { session: e.session, fieldKey: fieldKey(field), text: e.text } })
      return
    case 'final': {
      const clearTentative = st.tentative?.session === e.session ? { tentative: null } : {}
      // A closed tab takes nothing (setDraft would not write it either).
      if (useAppStore.getState().closedTabs.has(field.tabId)) {
        useVoice.setState(clearTentative)
        return
      }
      const key = fieldKey(field)
      const draft = draftOf(field)
      const at = st.caretByField[key] ?? draft.length
      const next = insertDictated(draft, at, e.text, { joinsPrevious: e.joinsPrevious })
      writeDraft(field, next.draft)
      const rev = (st.insertByField[key]?.rev ?? 0) + 1
      useVoice.setState({
        ...clearTentative,
        caretByField: { ...st.caretByField, [key]: next.caret },
        insertByField: { ...st.insertByField, [key]: { at: next.caret, rev } }
      })
      return
    }
    case 'done': {
      const { [e.session]: _gone, ...ending } = st.ending
      const patch: Partial<VoiceState> = { ending }
      if (st.tentative?.session === e.session) patch.tentative = null
      if (current) {
        stopMic()
        patch.session = null
      }
      useVoice.setState(patch)
      return
    }
    case 'error': {
      // engine-crashed, ort-conflict, load-failed, gpu-failed, engine-gave-up: unavailable, with its words.
      if (e.code === 'gpu-fallback') {
        if (current) useVoice.setState({ session: { ...current, note: voiceErrorText('gpu-fallback', voicePlatform()) } })
        return
      }
      const { [e.session]: _gone, ...ending } = st.ending
      useVoice.setState({ ending })
      if (current) {
        stopMic()
        hold.blur()
        fail(field.tabId, e.code)
      }
      return
    }
  }
}

// ------------------------------------------------------------------ presses

/** Windows' own dictation into the field (as before этап 5); nothing elsewhere. */
function windowsDictation(): void {
  if (voicePlatform() !== 'win32') return
  hooks.focusField()
  void window.qclod.startVoice()
}

/**
 * A press of the button (`menu`: it opens the menu where there is one) or of
 * Ctrl+Space and Ctrl+K (`key`: Win+H when there is no model, a retry when
 * voice was unavailable).
 */
export function pressVoice(tabId: TabId, source: 'button' | 'key', now = Date.now()): void {
  const st = useVoice.getState()
  if (!isRecording(st, tabId)) {
    if (missingModel(st) !== null) {
      if (source === 'key') windowsDictation()
      else useVoice.setState({ menuTab: st.menuTab === tabId ? null : tabId })
      return
    }
    // «Нажмите микрофон, чтобы запустить его снова»: a crash is retried by a press; other errors open the menu.
    if (st.error?.tabId === tabId && source === 'button' && st.error.code !== 'engine-crashed') {
      useVoice.setState({ menuTab: st.menuTab === tabId ? null : tabId })
      return
    }
  }
  const action = hold.down(isRecording(st, tabId), now)
  if (action === 'start') void begin(tabId)
  else if (action === 'stop') stopVoice()
}

export function releaseVoice(now = Date.now()): void {
  if (hold.up(now) === 'stop') stopVoice()
}

/** The window lost focus: a hold stops (its keyup will never come); a toggle goes on. */
export function blurVoice(): void {
  if (hold.blur() === 'stop') stopVoice()
}

/** The window was hidden (to the tray, minimised): the session stops, held or not. */
export function hideVoice(): void {
  stopVoice()
}

/** Ctrl+K «Голосовой ввод»: a short press on the active pane. */
export function toggleVoice(tabId: TabId): void {
  pressVoice(tabId, 'key')
  releaseVoice()
}

export function closeVoiceMenu(): void {
  if (useVoice.getState().menuTab !== null) useVoice.setState({ menuTab: null })
}

/** Starts listening to main: models and session events. Returns the stop. */
export function startVoiceSync(): () => void {
  void refreshModels()
  const offEvent = window.qclod.voice.onEvent(onVoiceEvent)
  const offModels = window.qclod.voice.onModelsChanged((models) => useVoice.setState({ models }))
  // A tab closed mid-session: the session stops, its texts are dropped (closedTabs).
  const offTabs = useAppStore.subscribe((app) => {
    const s = useVoice.getState().session
    if (s !== null && (app.closedTabs.has(s.tabId) || !app.tabs.some((t) => t.id === s.tabId))) stopVoice()
  })
  return () => {
    offEvent()
    offModels()
    offTabs()
    stopVoice()
  }
}

// ------------------------------------------------------------------ controls

const TITLE = {
  off: 'Голосовой ввод — Ctrl+Пробел. Нажмите и говорите или удерживайте',
  listening: 'Слушаю. Нажмите ещё раз, чтобы закончить',
  loading: 'Загружаю модель голоса…'
} as const

function menuFor(tabId: TabId, kind: 'download' | 'unavailable', model: VoiceModelId): VoiceMenuItem[] {
  const items: VoiceMenuItem[] = [
    kind === 'download'
      ? { id: 'download', label: `Скачать модель голоса (${modelSize(model)})`, onSelect: () => download(model) }
      : { id: 'retry', label: 'Попробовать снова', onSelect: () => void begin(tabId) }
  ]
  if (voicePlatform() === 'win32') {
    items.push({ id: 'windows', label: 'Диктовка Windows (Win+H)', onSelect: () => windowsDictation() })
  }
  items.push({ id: 'settings', label: 'Настройки голоса', onSelect: () => hooks.openSettings() })
  return items
}

/** The microphone button and the grey line of one tab, from the store as it is now. */
export function controlsFor(tabId: TabId, st: VoiceState = useVoice.getState()): VoiceControls {
  const field = fieldOf(tabId)
  const key = fieldKey(field)
  const tentative = st.tentative?.fieldKey === key ? st.tentative.text : ''
  const insert = st.insertByField[key]
  const base = {
    tentative,
    press: () => pressVoice(tabId, 'button'),
    release: () => releaseVoice(),
    caretMoved: (caret: number) => {
      const s = useVoice.getState()
      const k = fieldKey(fieldOf(tabId))
      if (s.caretByField[k] !== caret) useVoice.setState({ caretByField: { ...s.caretByField, [k]: caret } })
    },
    ...(insert ? { caretAfterInsert: insert } : {}),
    menuOpen: st.menuTab === tabId,
    closeMenu: closeVoiceMenu
  }
  const s = st.session
  if (s !== null && s.tabId === tabId && s.phase !== 'stopping') {
    if (s.phase === 'loading') return { ...base, state: 'loading', title: s.note ?? TITLE.loading, menu: [] }
    return { ...base, state: 'listening', title: s.note ?? TITLE.listening, menu: [] }
  }
  const missing = missingModel(st)
  if (missing !== null) {
    const title =
      missing.progress !== undefined
        ? `Скачиваю модель голоса: ${Math.round(missing.progress * 100)}%`
        : `Голосовой ввод: нужна модель (${modelSize(missing.id)})`
    return {
      ...base,
      state: 'download',
      title,
      ...(missing.progress !== undefined ? { progress: missing.progress } : {}),
      menu: menuFor(tabId, 'download', missing.id)
    }
  }
  if (st.error !== null && st.error.tabId === tabId) {
    return {
      ...base,
      state: 'unavailable',
      title: voiceErrorText(st.error.code, voicePlatform()),
      menu: menuFor(tabId, 'unavailable', selectedModel())
    }
  }
  return { ...base, state: 'off', title: TITLE.off, menu: [] }
}

/** A piece of the app's store, as it is now on the server render too. */
function useAppPiece<T>(pick: () => T): T {
  return useSyncExternalStore(useAppStore.subscribe, pick, pick)
}

/** The voice of one pane, for its Composer and its AgentComposer alike (сверка F12). */
export function useVoiceControls(tabId: TabId): VoiceControls {
  // The store as it is, on the server render too (zustand's own hook gives the initial state there).
  const st = useSyncExternalStore(useVoice.subscribe, useVoice.getState, useVoice.getState)
  const model = useAppPiece(() => useAppStore.getState().settings?.voice?.model)
  const layer = useAppPiece(() => useAppStore.getState().layerByTab[tabId])
  const ribbon = useAppPiece(() => useAppStore.getState().ribbonByTab[tabId])
  return useMemo(() => controlsFor(tabId, st), [tabId, st, model, layer, ribbon])
}
