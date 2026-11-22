import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { VoiceModelId, VoiceModelsSnapshot, VoiceModelView } from '../../shared/voice'
import { sanitizeModelId, sanitizePcm } from '../tabs/sanitize'
import type { VoiceHost } from './voiceHost'

/** What the IPC needs of the models' store (the ModelStore of task 6). */
export interface ModelStoreLike {
  snapshot(): VoiceModelView[] | Promise<VoiceModelView[]>
  download(id: VoiceModelId): Promise<void>
  cancel(id: VoiceModelId): void
  remove(id: VoiceModelId): Promise<void>
}

export interface VoiceIpcDeps {
  host: VoiceHost
  store: ModelStoreLike
  isOurWindow(id: number): boolean
  micAccess(): VoiceModelsSnapshot['micAccess']
  openMicSettings(): Promise<void>
  /** Opens Microsoft's fixed VC++ Redistributable link; the window passes nothing (I4). */
  openVcRedist(): Promise<void>
}

/** What the window is told about voice: the models, and whether the system lets us have the microphone. */
export async function voiceSnapshot(
  store: Pick<ModelStoreLike, 'snapshot'>,
  micAccess: () => VoiceModelsSnapshot['micAccess']
): Promise<VoiceModelsSnapshot> {
  return { models: await store.snapshot(), micAccess: micAccess() }
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

  ipcMain.handle(CHANNELS.voiceModels, () => voiceSnapshot(store, deps.micAccess))

  ipcMain.handle(CHANNELS.voiceDownload, async (_e, id: unknown) => {
    const model = sanitizeModelId(id)
    // A failed download is told by the model's state (error, in words), not by a rejection.
    if (model !== null) await store.download(model).catch(() => {})
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

  ipcMain.handle(CHANNELS.voiceOpenVcRedist, () => deps.openVcRedist())

  ipcMain.on(CHANNELS.voiceAudio, (e: Sender, session: unknown, pcm: unknown) => {
    if (!deps.isOurWindow(e.sender.id)) return
    const s = shortId(session)
    const samples = sanitizePcm(pcm)
    if (s === null || samples === null) return
    host.audio(e.sender.id, s, samples)
  })
}
