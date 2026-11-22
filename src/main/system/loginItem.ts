/**
 * Starts Qclod at login (the «автозапуск» setting). Only an installed build
 * registers anything: a dev run would put electron.exe in the user's startup.
 */
export function applyOpenAtLogin(
  app: Pick<Electron.App, 'isPackaged' | 'setLoginItemSettings' | 'getLoginItemSettings'>,
  enabled: boolean
): 'applied' | 'dev' {
  if (!app.isPackaged) return 'dev'
  app.setLoginItemSettings({ openAtLogin: enabled })
  return 'applied'
}
