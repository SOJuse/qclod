import type { AgentNode } from './agentModel'

export interface TimelineLayout {
  start: number
  end: number
  /** Shares of the scale, 0..1; width ≥ 0.004 so a blink still shows. */
  rows: Array<{ id: string; left: number; width: number; open: boolean }>
  /** `at` — a share of the scale, like the rows; the label counts from `start`. */
  ticks: Array<{ at: number; label: string }>
  /** Agents with no start time (an old record): not on the scale. */
  untimed: number
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const STEPS = [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 6 * HOUR]
const MAX_TICKS = 8
const MIN_WIDTH = 0.004

const pad = (n: number): string => String(n).padStart(2, '0')

/** «м:сс» under an hour, «ч:мм» from an hour on. */
function tickLabel(offset: number): string {
  if (offset < HOUR) {
    const total = Math.round(offset / SECOND)
    return `${Math.floor(total / 60)}:${pad(total % 60)}`
  }
  const total = Math.round(offset / MINUTE)
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}

/** Where an agent's bar ends: now while it works, else its end. */
function endOf(node: AgentNode & { startedAt: number }, now: number): number {
  if (node.state === 'running') return Math.max(node.startedAt, now)
  if (node.endedAt !== undefined) return node.endedAt
  if (node.durationMs !== undefined) return node.startedAt + node.durationMs
  return node.startedAt
}

/**
 * The agents on one time scale: a row each, by start time (ties keep ribbon
 * order), from the earliest start to the latest end — now, for one still at
 * work — and at least a second wide.
 */
export function layoutTimeline(nodes: AgentNode[], now: number): TimelineLayout {
  const timed = nodes
    .map((node, i) => ({ node, i }))
    .filter((e): e is { node: AgentNode & { startedAt: number }; i: number } => e.node.startedAt !== undefined)
    .sort((a, b) => a.node.startedAt - b.node.startedAt || a.i - b.i)
  const untimed = nodes.length - timed.length
  if (timed.length === 0) return { start: now, end: now + SECOND, rows: [], ticks: [], untimed }

  const start = timed[0]!.node.startedAt
  let end = start + SECOND
  for (const { node } of timed) end = Math.max(end, endOf(node, now))
  const span = end - start

  const rows = timed.map(({ node }) => {
    const from = node.startedAt - start
    const to = endOf(node, now) - start
    return {
      id: node.id,
      left: from / span,
      width: Math.max(MIN_WIDTH, (to - from) / span),
      open: node.state === 'running'
    }
  })

  const step = STEPS.find((s) => Math.floor(span / s) + 1 <= MAX_TICKS) ?? STEPS[STEPS.length - 1]!
  const ticks: TimelineLayout['ticks'] = []
  for (let at = 0; at <= span; at += step) ticks.push({ at: at / span, label: tickLabel(at) })

  return { start, end, rows, ticks, untimed }
}
