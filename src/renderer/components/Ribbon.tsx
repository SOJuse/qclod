import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RibbonItem as Item, TodoItem } from '../../shared/types'
import { childrenByParent } from '../chat/children'
import { RibbonRow } from './RibbonItem'
import { TodoPanel } from './TodoPanel'
import './Ribbon.css'

interface Props {
  items: Item[]
  todo: TodoItem[]
  /** The tab's folder, for the tool cards. */
  cwd: string
  tabId: string
  onAnswerPermission: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
  onAnswerQuestion: (toolUseId: string, answers: Record<string, string>) => void
  onAnswerPlan: (requestId: string, approve: boolean) => void
}

/**
 * How much is drawn beyond the viewport. Enough that a flick of the wheel
 * never shows a blank band, small enough that a ten-thousand-item session
 * costs the same as a ten-item one.
 */
const OVERSCAN = 600

/** Before a row is measured, this is what the window maths assumes it costs. */
const ASSUMED_ROW_HEIGHT = 44

/**
 * The conversation, one stream top to bottom.
 *
 * Virtualised by hand rather than with a library: rows here vary in height and
 * grow while they stream, which is exactly the case fixed-size virtualisers
 * get wrong, and the measuring loop below is smaller than the adapter a
 * general library would need.
 */
export function Ribbon({
  items,
  todo,
  cwd,
  tabId,
  onAnswerPermission,
  onAnswerQuestion,
  onAnswerPlan
}: Props): JSX.Element {
  const viewport = useRef<HTMLDivElement | null>(null)
  const heights = useRef(new Map<string, number>())
  const [, forceRender] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  /** Following the bottom is the default; scrolling up on purpose turns it off. */
  const stickToBottom = useRef(true)

  // Only top-level items are rows; a subagent's own calls live inside its card.
  // Both come from one pass over the ribbon per change, not one per card.
  const rows = useMemo(() => items.filter((item) => item.parentId === undefined), [items])
  const byParent = useMemo(() => childrenByParent(items), [items])

  const offsets: number[] = []
  let total = 0
  for (const row of rows) {
    offsets.push(total)
    total += heights.current.get(row.id) ?? ASSUMED_ROW_HEIGHT
  }

  let first = 0
  while (first < rows.length && offsets[first]! + (heights.current.get(rows[first]!.id) ?? ASSUMED_ROW_HEIGHT) < scrollTop - OVERSCAN) {
    first++
  }
  let last = first
  while (last < rows.length && offsets[last]! < scrollTop + viewportHeight + OVERSCAN) last++

  const visible = rows.slice(first, last)
  const padTop = offsets[first] ?? 0
  // Everything from the first row not drawn to the end; past the last row, nothing.
  const padBottom = total - (offsets[last] ?? total)

  const measure = useCallback((id: string, height: number) => {
    const known = heights.current.get(id)
    if (known !== undefined && Math.abs(known - height) < 1) return
    heights.current.set(id, height)
    forceRender((n) => n + 1)
  }, [])

  const onScroll = useCallback((): void => {
    const el = viewport.current
    if (!el) return
    setScrollTop(el.scrollTop)
    stickToBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40
  }, [])

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    setViewportHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  // A tab opens at the end of its conversation, which is where the work is.
  // The component is keyed by tab, so this runs once per tab rather than
  // carrying the previous tab's position into the new one.
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    stickToBottom.current = true
  }, [])

  useLayoutEffect(() => {
    const el = viewport.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
  }, [items, total])

  return (
    <div className="ribbon-wrap">
      {todo.length > 0 && <TodoPanel items={todo} />}
      <div className="ribbon" data-testid="ribbon" ref={viewport} onScroll={onScroll}>
        <div style={{ height: padTop }} aria-hidden />
        {visible.map((item) => (
          <RibbonRow
            key={item.id}
            item={item}
            byParent={byParent}
            cwd={cwd}
            tabId={tabId}
            onMeasure={measure}
            onAnswerPermission={onAnswerPermission}
            onAnswerQuestion={onAnswerQuestion}
            onAnswerPlan={onAnswerPlan}
          />
        ))}
        <div style={{ height: padBottom }} aria-hidden />
      </div>
    </div>
  )
}
