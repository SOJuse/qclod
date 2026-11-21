import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { VoiceModelId, VoiceModelsSnapshot } from '../../shared/voice'
import { sanitizeModelId, sanitizePcm } from '../tabs/sanitize'
import type { VoiceHost } from './voiceHost'

/** What the IPC needs of the models' store (the ModelStore of task 6). */
export interface ModelStoreLike {
  snapshot(): VoiceModelsSnapshot | Promise<VoiceModelsSnapshot>
  download(id: VoiceModelId): Promise<void>
  cancel(id: VoiceModelId): void
  remove(id: VoiceModelId): Promise<void>
}

export interface VoiceIpcDeps {
  host: VoiceHost
  store: ModelStoreLike
  isOurWindow(id: number): boolean
  openMicSettings(): Promise<void>
}

const MAX_ID = 100

/** A tab id or a session id: a non-empty string of at most 100 characters. */
function shortId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null
}

interface Sender {
  sender: { id: number }
}

/**
 * Everything the window may ask of voice. Each argument is checked here; the
 * sound only counts from our own window, and the host drops sound and stops
 * for a session the sender does not own.
 */
export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { host, store } = deps

  ipcMain.handle(CHANNELS.voiceModels, () => store.snapshot())

  ipcMain.handle(CHANNELS.voiceDownload, async (_e, id: unknown) => {
    const model = sanitizeModelId(id)
    if (model !== null) await store.download(model)
  })

  ipcMain.handle(CHANNELS.voiceCancelDownload, (_e, id: unknown) => {
    const model = sanitizeModelId(id)
    if (model !== null) store.cancel(model)
  })

  ipcMain.handle(CHANNELS.voiceDelete, async (_e, id: unknown) => {
    const model = sanitizeModelId(id)
    if (model !== null) await store.remove(model)
  })

  ipcMain.handle(CHANNELS.voiceBegin, (e: Sender, tabId: unknown) => {
    const tab = shortId(tabId)
    if (tab === null || !deps.isOurWindow(e.sender.id)) throw new Error('voice: bad begin')
    return host.begin(e.sender.id, tab)
  })

  ipcMain.handle(CHANNELS.voiceEnd, (e: Sender, session: unknown) => {
    const s = shortId(session)
    if (s === null || !deps.isOurWindow(e.sender.id)) return
    host.end(e.sender.id, s)
  })

  ipcMain.handle(CHANNELS.voiceOpenMicSettings, () => deps.openMicSettings())

  ipcMain.on(CHANNELS.voiceAudio, (e: Sender, session: unknown, pcm: unknown) => {
    if (!deps.isOurWindow(e.sender.id)) return
    const s = shortId(session)
    const samples = sanitizePcm(pcm)
    if (s === null || samples === null) return
    host.audio(e.sender.id, s, samples)
  })
}
