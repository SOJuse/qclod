import type { AppSettings } from '../../../shared/types'

export function Group({ title, children }: { title?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="settings-group">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="settings-field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

export function Toggle({
  id,
  label,
  checked,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        data-testid={`setting-${id}`}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

/** The screen already shows a refusal; a section only has to not leave it unhandled. */
export function save(patch: (p: Partial<AppSettings>) => Promise<AppSettings>, p: Partial<AppSettings>): void {
  patch(p).catch(() => undefined)
}

/** A «Повторить» goes with its error; focus stays in the sheet rather than falling to the page. */
export function retryIn(run: () => void): () => void {
  return () => {
    document.activeElement?.closest<HTMLElement>('[role="dialog"]')?.focus()
    run()
  }
}
