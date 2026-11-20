import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import './PaneLayer.css'

interface Props {
  title: string
  onClose(): void
  children: ReactNode
}

/**
 * A layer over a pane's ribbon: subagents (этап 4), a file (этап 6), git
 * (этап 7). One per pane (useAppStore.layerByTab). Opened, it takes the
 * focus; Esc or «Закрыть» closes it, and the focus goes back where it was.
 */
export function PaneLayer({ title, onClose, children }: Props): JSX.Element {
  const self = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const node = self.current
    node?.focus()
    return () => {
      // Back to the opener if it is still there and nothing else took the focus meanwhile.
      const active = document.activeElement
      const lost = !active || active === document.body || node?.contains(active) === true
      if (lost && before && before.isConnected) before.focus()
    }
  }, [])
  return (
    <div
      ref={self}
      className="pane-layer"
      data-testid="pane-layer"
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key !== 'Escape' || ev.defaultPrevented) return
        ev.preventDefault()
        ev.stopPropagation()
        onClose()
      }}
    >
      <header className="pane-layer-head">
        <span className="pane-layer-title">{title}</span>
        <button
          type="button"
          className="pane-layer-close"
          data-testid="pane-layer-close"
          aria-label="Закрыть"
          title="Закрыть — Esc"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="pane-layer-body">{children}</div>
    </div>
  )
}
