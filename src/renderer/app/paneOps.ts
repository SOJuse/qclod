import { MAX_PANES } from '../chat/sidebarModel'
import type { TabId } from '../../shared/types'

/** Where on a pane a chat was let go: its left or right quarter, or its middle. */
export type DropWhere = 'before' | 'after' | 'replace'

/** The drag of an open chat from the sidebar: the data is its tab id. */
export const DRAG_CHAT = 'application/x-qclod-chat'
/** The drag of a past conversation: JSON `{ cwd, sessionId, title }`. */
export const DRAG_SESSION = 'application/x-qclod-session'
/**
 * Marks a chat drag whose chat is already in the row. The data of a drag
 * cannot be read until the drop, its types can: this is how a full row knows
 * to frame its edges for a move.
 */
export const DRAG_IN_ROW = 'application/x-qclod-in-row'

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

/** A row: its shares, its visible width, the narrowest pane allowed. */
export interface RowMeasure {
  shares: number[]
  viewPx: number
  minPx: number
}

const total = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

/**
 * `totalPx` shared out by `shares`, no pane under `minPx`: the panes a share
 * would make too narrow are held at the minimum and the rest share what is
 * left in their own proportions (what a flex row with `min-width` does).
 */
export function fillRow(shares: number[], totalPx: number, minPx: number): number[] {
  const n = shares.length
  if (n === 0) return []
  if (n * minPx >= totalPx) return shares.map(() => minPx)
  const held = new Set<number>()
  for (;;) {
    const free = shares.map((_w, i) => i).filter((i) => !held.has(i))
    const room = totalPx - held.size * minPx
    const freeShares = free.reduce((sum, i) => sum + Math.max(0, shares[i]!), 0)
    const out = shares.map((w, i) =>
      held.has(i) ? minPx : freeShares > 0 ? (Math.max(0, w) / freeShares) * room : room / free.length
    )
    const under = free.filter((i) => out[i]! < minPx)
    if (under.length === 0) return out
    for (const i of under) held.add(i)
  }
}

/**
 * How wide a row that does not fit is drawn: its N panes at the minimum plus
 * room for a splitter to move (up to one more minimum). It grows from the
 * window's width as the window narrows past N × `--pane-min-w`, so the two
 * ways of drawing meet at the threshold.
 */
export function scrolledRowWidth(n: number, viewPx: number, minPx: number): number {
  const least = n * minPx
  return least + Math.min(Math.max(0, least - viewPx), minPx)
}

/**
 * The panes of a row `viewPx` wide, in px.
 *
 * - N × `--pane-min-w` fits: the visible width shared out by the shares, no
 *   pane under the minimum (fillRow). This never scrolls.
 * - It does not: the row is scrolledRowWidth wide and scrolls sideways; the
 *   shares are shared out over that width the same way.
 *
 * Either way the picture is the shares and the window's width alone, so the
 * same saved shares in the same window draw the same row.
 */
export function rowLayout(shares: number[], viewPx: number, minPx: number): { scrolls: boolean; px: number[] } {
  const n = shares.length
  if (n < 2) return { scrolls: false, px: n === 1 ? [viewPx] : [] }
  if (n * minPx <= viewPx) return { scrolls: false, px: fillRow(shares, viewPx, minPx) }
  return { scrolls: true, px: fillRow(shares, scrolledRowWidth(n, viewPx, minPx), minPx) }
}

/**
 * The shares after a splitter moved by `deltaPx`, from the row as rowLayout
 * draws it: a share the minimum overrides moves from where it is seen.
 *
 * - The row fits: the two neighbours trade (resizePanes over the visible
 *   width). Shares the minimum does not override are used as they are.
 * - The row scrolls: its width stays; the splitter pushes. Moving right, the
 *   pane on its left grows and the panes on its right give way, nearest
 *   first, each down to the minimum; moving left, the other way round. The
 *   splitter follows as far as there is room, in any spread of widths.
 *
 * The result is the drawn widths over the row's width, so rowLayout draws it
 * back exactly.
 */
export function moveSplitter(row: RowMeasure, splitter: number, deltaPx: number): number[] {
  const { shares, viewPx, minPx } = row
  const n = shares.length
  if (splitter < 0 || splitter + 1 >= n || !Number.isFinite(deltaPx) || !(viewPx > 0)) return shares
  const { scrolls, px: panePx } = rowLayout(shares, viewPx, minPx)
  const width = total(panePx)
  if (!scrolls) {
    // Unchanged where no minimum overrides a share: the shares as they are.
    const drawn = panePx.every((w, i) => Math.abs(w - shares[i]! * viewPx) < 1e-6) ? shares : panePx.map((w) => w / width)
    return resizePanes(drawn, splitter, deltaPx, viewPx, minPx)
  }

  const px = [...panePx]
  const grows = deltaPx > 0 ? splitter : splitter + 1
  // The panes that give way, nearest the splitter first.
  const givers =
    deltaPx > 0
      ? Array.from({ length: n - splitter - 1 }, (_v, k) => splitter + 1 + k)
      : Array.from({ length: splitter + 1 }, (_v, k) => splitter - k)
  let want = Math.abs(deltaPx)
  for (const i of givers) {
    if (want <= 0) break
    const give = Math.min(want, Math.max(0, px[i]! - minPx))
    px[i] = px[i]! - give
    px[grows] = px[grows]! + give
    want -= give
  }
  return px.map((w) => w / width)
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

/**
 * The zone a drag over a pane would land in, or null where it would land
 * nowhere. A full row has no room beside a pane: its edges take only a chat
 * already in the row (DRAG_IN_ROW), which moves there; anything else may only
 * take a pane's place. What is not framed takes no drop.
 */
export function dropZone(where: DropWhere, types: readonly string[], paneCount: number): DropWhere | null {
  if (!carriesDrop(types)) return null
  if (where !== 'replace' && paneCount >= MAX_PANES && !types.includes(DRAG_IN_ROW)) return null
  return where
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
