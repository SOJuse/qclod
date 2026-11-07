import { useEffect, useState } from 'react'
import type { RibbonItem, SessionStatus } from '../../shared/types'
import './Working.css'

interface Props {
  status: SessionStatus
  /** When this turn started, epoch ms. */
  since: number | undefined
  items: RibbonItem[]
}

const MARKS = ['✶', '✸', '✹', '✺', '✹', '✷']

/**
 * Proof that something is happening.
 *
 * While the agent thinks, the ribbon has nothing to show — no text yet, no
 * tool card yet — and an empty screen reads as a broken app rather than a busy
 * one. This is the line that says otherwise: what it is doing, for how long,
 * and how to stop it.
 */
export function Working({ status, since, items }: Props): JSX.Element | null {
  const [tick, setTick] = useState(0)

  const working = status === 'busy' || status === 'waiting'

  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [working])

  if (!working) return null

  const elapsed = since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0
  const mark = MARKS[tick % MARKS.length]

  return (
    <div className={`working is-${status}`} data-testid="working">
      <span className="working-mark" aria-hidden>
        {mark}
      </span>
      <span className="working-what" data-testid="working-what">
        {describe(status, items)}
      </span>
      <span className="working-time" data-testid="working-time">
        {spell(elapsed)}
      </span>
      <span className="working-hint">Esc — прервать</span>
    </div>
  )
}

/** What the agent is doing right now, from the newest thing it started. */
function describe(status: SessionStatus, items: RibbonItem[]): string {
  if (status === 'waiting') return 'ждёт вашего ответа'

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'tool' && item.state === 'running') {
      return item.target ? `${item.name} · ${item.target}` : item.name
    }
    if (item.kind === 'subagent' && item.state === 'running') {
      return `${item.name} · ${item.task}`
    }
    if (item.kind === 'thinking' && !item.done) return 'думает'
    if (item.kind === 'agentText' && item.streaming) return 'пишет ответ'
  }
  return 'думает'
}

/** «42 секунды», «2 минуты 5 секунд» — the shape the CLI uses, in words. */
function spell(seconds: number): string {
  if (seconds < 60) return `${seconds} ${plural(seconds, 'секунда', 'секунды', 'секунд')}`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  const head = `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`
  return rest === 0 ? head : `${head} ${rest} ${plural(rest, 'секунда', 'секунды', 'секунд')}`
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
}
