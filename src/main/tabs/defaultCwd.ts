// The folder a new tab starts in. A packaged app's process.cwd() is the install
// folder or System32, so only a development run may use it.
export function pickDefaultCwd(isPackaged: boolean, cwd: string, home: string): string {
  if (isPackaged) return home
  return cwd || home
}
