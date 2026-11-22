import { ipcMain, type BrowserWindow } from 'electron'
import { CHANNELS } from '../shared/channels'
import type { TemplateDraft } from '../shared/types'
import type { TemplateLibrary } from './store/templatesStore'
import type { HarvestService } from './templates/harvest'
import { isTemplateId, sanitizeExcludedProjects, sanitizeTemplateDraft } from './tabs/sanitize'
import { withFault } from './testSeams/ipcFaults'

/**
 * The template library over IPC. Everything from the window is checked here:
 * a draft through sanitizeTemplateDraft, an id against the id pattern, a
 * list must be an array. Every change goes back to the window as
 * `templates:changed` with the whole list.
 */
export function registerTemplatesIpc(deps: {
  library: TemplateLibrary
  getWindow: () => BrowserWindow | null
  /** «Собрать мои шаблоны»; without it the harvest channels are not registered. */
  harvest?: HarvestService
}): void {
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

  const harvest = deps.harvest
  if (!harvest) return
  // The window names projects to leave out, never texts: what is sent is what main read.
  ipcMain.handle(CHANNELS.harvestPreview, (_e, raw: unknown) =>
    withFault(CHANNELS.harvestPreview, () => harvest.preview(sanitizeExcludedProjects(raw)))
  )
  ipcMain.handle(CHANNELS.harvestRun, (_e, raw: unknown) =>
    withFault(CHANNELS.harvestRun, () => harvest.run(sanitizeExcludedProjects(raw)))
  )
  ipcMain.handle(CHANNELS.harvestCancel, () => withFault(CHANNELS.harvestCancel, () => harvest.cancel()))
}
