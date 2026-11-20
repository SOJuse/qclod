/**
 * One Qclod per profile: a second one (login start plus a shortcut) would share
 * tabs.json with the first and both would carry on the same conversations.
 * The lock is tied to userData, so test profiles do not meet.
 *
 * false: another Qclod has the lock; this one is quitting and must start nothing.
 * `onSecond` is called in the first one when a second is started.
 */
export function claimSingleInstance(
  app: Pick<Electron.App, 'requestSingleInstanceLock' | 'on' | 'quit'>,
  onSecond: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => onSecond())
  return true
}
