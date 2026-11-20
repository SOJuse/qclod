import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { TabId } from '../../shared/types'
import { MAX_PANES } from '../chat/sidebarModel'
import {
  carriesDrop,
  dropWhere,
  equalWidths,
  readDrop,
  resizePanes,
  type DropPayload,
  type DropWhere
} from './paneOps'
import './SplitView.css'

/** How far one arrow key moves a splitter. */
const KEY_STEP_PX = 16
/** `--pane-min-w` when the style cannot be read. */
const FALLBACK_MIN_PX = 320

interface Props {
  /** Left to right, at most MAX_PANES. */
  panes: TabId[]
  /** Shares of the row, one per pane; anything else means equal. */
  widths: number[]
  activeTabId: TabId
  renderPane: (id: TabId, index: number) => ReactNode
  /** A chat or a past conversation let go on pane `index`. */
  onDrop: (index: number, where: DropWhere, payload: DropPayload) => void
  /** New shares, once a splitter is let go (or moved by a key, or reset). */
  onResize: (widths: number[]) => void
  /** A press anywhere in a pane, its error fallback included. */
  onFocus: (id: TabId) => void
}

/** The smallest pane the row allows, in px. */
function minPaneWidth(row: HTMLElement): number {
  const px = parseFloat(getComputedStyle(row).getPropertyValue('--pane-min-w'))
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_MIN_PX
}

/**
 * The chats side by side, left to right (E3), up to four (E2).
 *
 * - A chat dragged from the sidebar onto a pane's outer quarter goes beside
 *   it, onto its middle in its place; the zone it would land in is framed.
 * - A splitter between two panes moves with the mouse, by 16 px with the
 *   arrow keys, and back to equal with a double click. No pane gets narrower
 *   than `--pane-min-w`; a window too narrow for them scrolls the row sideways.
 * - The active pane is framed in the accent, only when there is more than one.
 */
export function SplitView({ panes, widths, activeTabId, renderPane, onDrop, onResize, onFocus }: Props): JSX.Element {
  const row = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ index: number; where: DropWhere } | null>(null)
  /** Shares while a splitter is held: only this view redraws until it is let go. */
  const [live, setLive] = useState<number[] | null>(null)
  const held = useRef<{ splitter: number; x: number; base: number[]; now: number[]; total: number; min: number } | null>(
    null
  )

  const split = panes.length > 1
  const shares = live ?? (widths.length === panes.length ? widths : equalWidths(panes.length))
  const full = panes.length >= MAX_PANES

  // The panes themselves do not redraw while a splitter moves.
  const rendered = useMemo(() => panes.map((id, index) => renderPane(id, index)), [panes, renderPane])

  // A drag that ends anywhere (let go outside, Esc) leaves no zone framed.
  useEffect(() => {
    const clear = (): void => setHover(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  // The active pane is scrolled into the row's view: a pane added to a narrow
  // window is otherwise past its edge.
  useEffect(() => {
    const box = row.current
    const pane = box?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(activeTabId)}"]`)
    if (!box || !pane) return
    const outer = box.getBoundingClientRect()
    const inner = pane.getBoundingClientRect()
    if (inner.left < outer.left) box.scrollLeft -= outer.left - inner.left
    else if (inner.right > outer.right) box.scrollLeft += Math.min(inner.right - outer.right, inner.left - outer.left)
  }, [activeTabId, panes])

  const zoneOf = (e: DragEvent<HTMLElement>): DropWhere => {
    const rect = e.currentTarget.getBoundingClientRect()
    return dropWhere(e.clientX - rect.left, rect.width)
  }

  // Captured on the pane, so the input line's own file drop never sees a chat.
  const dragOver = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!carriesDrop(Array.from(e.dataTransfer.types))) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const where = zoneOf(e)
    // A full row takes nothing beside a pane, so its edges are not framed.
    const shown = full && where !== 'replace' ? null : { index, where }
    setHover((was) => (was?.index === shown?.index && was?.where === shown?.where ? was : shown))
  }
  const dragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null)
  }
  const drop = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!carriesDrop(Array.from(e.dataTransfer.types))) return
    e.preventDefault()
    e.stopPropagation()
    setHover(null)
    const payload = readDrop((type) => e.dataTransfer.getData(type))
    if (payload) onDrop(index, zoneOf(e), payload)
  }

  const commit = (): void => {
    const h = held.current
    held.current = null
    setLive(null)
    if (h && h.now !== h.base) onResize(h.now)
  }

  return (
    <div ref={row} className={`split-row${split ? ' is-split' : ''}`} data-testid="split-row">
      {panes.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && (
            <div
              className={`pane-splitter${held.current?.splitter === index - 1 ? ' is-held' : ''}`}
              data-testid="pane-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Ширина панелей"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((shares[index - 1] ?? 0) * 100)}
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.button !== 0 || !row.current) return
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                held.current = {
                  splitter: index - 1,
                  x: e.clientX,
                  base: shares,
                  now: shares,
                  total: row.current.clientWidth,
                  min: minPaneWidth(row.current)
                }
                setLive(shares)
              }}
              onPointerMove={(e) => {
                const h = held.current
                if (!h) return
                h.now = resizePanes(h.base, h.splitter, e.clientX - h.x, h.total, h.min)
                setLive(h.now)
              }}
              onPointerUp={commit}
              onLostPointerCapture={() => {
                if (held.current) commit()
              }}
              onDoubleClick={() => onResize(equalWidths(panes.length))}
              onKeyDown={(e) => {
                if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !row.current) return
                e.preventDefault()
                const step = e.key === 'ArrowLeft' ? -KEY_STEP_PX : KEY_STEP_PX
                const next = resizePanes(shares, index - 1, step, row.current.clientWidth, minPaneWidth(row.current))
                if (next !== shares) onResize(next)
              }}
            />
          )}
          <div
            className={`split-pane${id === activeTabId ? ' is-active' : ''}`}
            data-testid="split-pane"
            data-pane={id}
            style={{ flexGrow: shares[index] ?? 1 }}
            onMouseDown={() => onFocus(id)}
            onDragOverCapture={dragOver(index)}
            onDragLeave={dragLeave}
            onDropCapture={drop(index)}
          >
            {rendered[index]}
            {hover?.index === index && (
              <div className="split-drop" data-testid="split-drop" data-where={hover.where} aria-hidden="true" />
            )}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
