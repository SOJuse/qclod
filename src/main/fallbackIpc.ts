import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { CHANNELS } from '../shared/channels'

/** The static page's ways out: «Попробовать снова» and «Открыть журнал». */
export function registerFallbackIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle'>
  openPath: (path: string) => Promise<string>
  userData: string
  /** The watchdog's `reset()`, so a retry starts the reload count afresh. */
  resetWatch: () => void
  reload: () => void
}): void {
  deps.ipcMain.handle(CHANNELS.rendererRetry, () => {
    deps.resetWatch()
    deps.reload()
  })
  deps.ipcMain.handle(CHANNELS.logsOpen, async () => {
    const failure = await deps.openPath(join(deps.userData, 'logs'))
    if (failure) throw new Error(failure)
  })
}
