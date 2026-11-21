import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS } from '../shared/channels'
import type { TemplateDraft } from '../shared/types'
import type { TemplateLibrary } from './store/templatesStore'
import { isTemplateId, sanitizeTemplateDraft } from './tabs/sanitize'
import { withFault } from './testSeams/ipcFaults'

/**
 * The template library over IPC. Everything from the window is checked here:
 * a draft through sanitizeTemplateDraft, an id against the id pattern, a
 * list must be an array. Every change goes back to the window as
 * `templates:changed` with the whole list.
 */
export function registerTemplatesIpc(deps: { library: TemplateLibrary; getWindow: () => BrowserWindow | null }): void {
  const { library } = deps

  library.onChange((list) => {
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.templatesChanged, list)
  })

  ipcMain.handle(CHANNELS.templatesList, () => withFault(CHANNELS.templatesList, () => library.list()))

  ipcMain.handle(CHANNELS.templatesSave, (_e, raw: unknown) =>
    withFault(CHANNELS.templatesSave, () => {
      const draft = sanitizeTemplateDraft(raw)
      return draft ? library.save(draft) : null
    })
  )

  ipcMain.handle(CHANNELS.templatesSaveMany, (_e, raw: unknown) =>
    withFault(CHANNELS.templatesSaveMany, () => {
      if (!Array.isArray(raw)) return 0
      const drafts = raw.map(sanitizeTemplateDraft).filter((d): d is TemplateDraft => d !== null)
      return library.saveMany(drafts)
    })
  )

  ipcMain.handle(CHANNELS.templatesDelete, (_e, raw: unknown) =>
    withFault(CHANNELS.templatesDelete, () => (isTemplateId(raw) ? library.remove(raw) : false))
  )
}
