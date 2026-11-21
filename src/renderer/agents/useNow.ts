import { useEffect, useState } from 'react'

/**
 * The time, once a second while `active` and the window is in view; otherwise
 * it stands. A hidden window does not tick: nobody reads the clock there.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisibility = (): void => (document.visibilityState === 'visible' ? start() : stop())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
  return now
}
