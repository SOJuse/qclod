import { MAX_PANES } from '../chat/sidebarModel'
import type { TabId } from '../../shared/types'

/** Where on a pane a chat was let go: its left or right quarter, or its middle. */
export type DropWhere = 'before' | 'after' | 'replace'

/** The drag of an open chat from the sidebar: the data is its tab id. */
export const DRAG_CHAT = 'application/x-qclod-chat'
/** The drag of a past conversation: JSON `{ cwd, sessionId, title }`. */
export const DRAG_SESSION = 'application/x-qclod-session'

/** What a drop onto a pane brings. */
export type DropPayload =
  | { kind: 'chat'; tabId: TabId }
  | { kind: 'session'; cwd: string; sessionId: string; title: string }

/** How much of a pane's width, on each side, puts a chat beside it rather than in it. */
const EDGE = 0.25

/**
 * The panes after `dragged` was let go on the pane at `index`.
 *
 * - A chat already in the row moves (`before`/`after`) or trades places with
 *   the target (`replace`): it is never shown twice.
 * - On itself nothing changes.
 * - A new chat beside a full row (MAX_PANES) changes nothing: there is no fifth pane.
 *
 * Nothing to change returns `panes` itself.
 */
export function dropOnPane(panes: TabId[], dragged: TabId, index: number, where: DropWhere): TabId[] {
  const target = panes[index]
  if (target === undefined || target === dragged) return panes
  const from = panes.indexOf(dragged)

  if (where === 'replace') {
    const next = [...panes]
    next[index] = dragged
    if (from !== -1) next[from] = target
    return next
  }

  if (from === -1 && panes.length >= MAX_PANES) return panes
  const rest = panes.filter((id) => id !== dragged)
  const at = rest.indexOf(target) + (where === 'after' ? 1 : 0)
  const next = [...rest.slice(0, at), dragged, ...rest.slice(at)]
  return next.every((id, i) => id === panes[i]) && next.length === panes.length ? panes : next
}

/**
 * The shares after the splitter between pane `splitter` and the next one
 * moved by `deltaPx` in a row `totalPx` wide. Only those two panes change,
 * neither gets narrower than `minPx`, and the shares still add up to 1. When
 * the two cannot both be `minPx` wide the shares stay as they are: the row
 * is then wider than the window and scrolls.
 */
export function resizePanes(
  widths: number[],
  splitter: number,
  deltaPx: number,
  totalPx: number,
  minPx: number
): number[] {
  const left = widths[splitter]
  const right = widths[splitter + 1]
  if (left === undefined || right === undefined || !(totalPx > 0) || !Number.isFinite(deltaPx)) return widths
  const pair = left + right
  const min = minPx / totalPx
  if (2 * min > pair) return widths
  const nextLeft = Math.min(pair - min, Math.max(min, left + deltaPx / totalPx))
  const next = [...widths]
  next[splitter] = nextLeft
  next[splitter + 1] = pair - nextLeft
  return next
}

/** `n` equal shares. */
export function equalWidths(n: number): number[] {
  return n > 0 ? Array.from({ length: n }, () => 1 / n) : []
}

/** The zone of a pane `width` wide that `x` (from its left edge) falls in. */
export function dropWhere(x: number, width: number): DropWhere {
  if (x < width * EDGE) return 'before'
  if (x > width * (1 - EDGE)) return 'after'
  return 'replace'
}

/** Whether a drag carries something a pane takes (its types are readable while it is under way). */
export function carriesDrop(types: readonly string[]): boolean {
  return types.includes(DRAG_CHAT) || types.includes(DRAG_SESSION)
}

/** What a drop brings, read from its data; anything else is null. */
export function readDrop(getData: (type: string) => string): DropPayload | null {
  const tabId = getData(DRAG_CHAT)
  if (tabId) return { kind: 'chat', tabId }
  const raw = getData(DRAG_SESSION)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { cwd, sessionId, title } = value as Record<string, unknown>
    if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || !sessionId || typeof title !== 'string') {
      return null
    }
    return { kind: 'session', cwd, sessionId, title }
  } catch {
    return null
  }
}
