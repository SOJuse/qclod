import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Sparkles, X } from 'lucide-react'
import { TEMPLATE_LIMITS, type PromptTemplate } from '../../../shared/types'
import { templateHits } from '../../input/templates'
import { useTemplates } from '../../state/useTemplates'
import { useModalFocus } from '../../ui/modalFocus'
import './TemplateManager.css'

interface Props {
  /** «Сохранить черновик как шаблон»: the editor opens on a new template with this text. */
  initialBody?: string
  onClose(): void
  onHarvest(): void
  /** Closing gives focus back to the opener; this runs when the opener is gone. */
  onFocusLost?(): void
}

/** What the editor holds: a new template has no id. */
interface Editing {
  id?: string
  title: string
  body: string
}

/** The owner's templates in a small sheet, as Ctrl+K looks: find, create, edit, delete. */
export function TemplateManager(props: Props): JSX.Element {
  const templates = useTemplates()
  return <TemplateManagerView {...props} templates={templates} />
}

/**
 * The manager itself, given the list. A change is saved by «Сохранить» only;
 * closing with an unsaved edit lets it go without asking — one action, not a
 * setting (A10).
 */
export function TemplateManagerView({
  templates,
  initialBody,
  onClose,
  onHarvest,
  onFocusLost
}: Props & { templates: PromptTemplate[] }): JSX.Element {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(() =>
    initialBody === undefined ? null : { title: '', body: initialBody }
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const sheet = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const bodyField = useRef<HTMLTextAreaElement | null>(null)
  const trap = useModalFocus(sheet, onFocusLost)

  useEffect(() => {
    if (initialBody !== undefined) bodyField.current?.focus()
    else search.current?.focus()
    // On open only.
  }, [])

  const full = templates.length >= TEMPLATE_LIMITS.maxCount
  const shown = useMemo(() => {
    if (query.trim() === '') return [...templates].sort((a, b) => b.updatedAt - a.updatedAt)
    const byId = new Map(templates.map((t) => [t.id, t]))
    return templateHits(templates, query, TEMPLATE_LIMITS.maxCount).map((h) => byId.get(h.id)!)
  }, [templates, query])
  const editedOne = editing?.id !== undefined ? templates.find((t) => t.id === editing.id) : undefined

  const open = (next: Editing | null): void => {
    setEditing(next)
    setConfirmDelete(false)
    setFailed(null)
  }

  const save = async (): Promise<void> => {
    if (!editing || editing.body.trim() === '') return
    const saved = await window.qclod.templatesSave({
      ...(editing.id !== undefined ? { id: editing.id } : {}),
      title: editing.title,
      body: editing.body
    })
    if (saved) open(null)
    else setFailed(full ? 'Шаблонов уже 500 — удалите ненужные.' : 'Не сохранилось.')
  }

  const remove = async (): Promise<void> => {
    if (editing?.id === undefined) return
    await window.qclod.templatesDelete(editing.id)
    open(null)
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        ref={sheet}
        className="sheet template-manager"
        data-testid="template-manager"
        role="dialog"
        aria-modal="true"
        aria-label="Шаблоны"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onClose()
            return
          }
          trap(e)
        }}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">Шаблоны</h2>
          <button type="button" className="btn btn-sm btn-ghost" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="template-manager-bar">
          <input
            ref={search}
            className="field template-manager-search"
            data-testid="tpl-search"
            placeholder="Найти шаблон"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            data-testid="tpl-new"
            disabled={full}
            onClick={() => open({ title: '', body: '' })}
          >
            <Plus size={14} aria-hidden="true" />
            Новый шаблон
          </button>
          <button type="button" className="btn" data-testid="tpl-harvest" onClick={onHarvest}>
            <Sparkles size={14} aria-hidden="true" />
            Собрать мои шаблоны
          </button>
        </div>

        <div className="sheet-body template-manager-body">
          {full && (
            <p className="template-manager-note" data-testid="tpl-limit" role="status">
              Шаблонов уже 500 — удалите ненужные.
            </p>
          )}

          {editing && (
            <form
              className="template-editor"
              data-testid="tpl-editor"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <label className="template-editor-row">
                <span className="field-label">Название</span>
                <input
                  className="field"
                  data-testid="tpl-title"
                  maxLength={TEMPLATE_LIMITS.title}
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
              </label>
              <label className="template-editor-row">
                <span className="field-label">Текст</span>
                <textarea
                  ref={bodyField}
                  className="field template-editor-body"
                  data-testid="tpl-body"
                  rows={6}
                  maxLength={TEMPLATE_LIMITS.body}
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                />
              </label>
              <p className="field-hint">{'{{…}} — место, которое нужно заполнить: после вставки оно будет выделено.'}</p>
              {failed && (
                <p className="template-manager-note is-failed" role="alert">
                  {failed}
                </p>
              )}
              {confirmDelete && editedOne ? (
                <div className="template-editor-actions" data-testid="tpl-confirm" role="alert">
                  <span className="template-editor-question">Удалить шаблон «{editedOne.title}»?</span>
                  <button type="button" className="btn btn-danger" data-testid="tpl-delete-confirm" onClick={() => void remove()}>
                    Удалить
                  </button>
                  <button type="button" className="btn" data-testid="tpl-delete-cancel" onClick={() => setConfirmDelete(false)}>
                    Отмена
                  </button>
                </div>
              ) : (
                <div className="template-editor-actions">
                  {editedOne && (
                    <button type="button" className="btn btn-danger" data-testid="tpl-delete" onClick={() => setConfirmDelete(true)}>
                      Удалить
                    </button>
                  )}
                  <button
                    type="submit"
                    className="btn btn-primary"
                    data-testid="tpl-save"
                    disabled={editing.body.trim() === ''}
                  >
                    Сохранить
                  </button>
                </div>
              )}
            </form>
          )}

          {templates.length === 0 ? (
            !editing && (
              <p className="template-manager-empty" data-testid="tpl-empty">
                Шаблонов пока нет. Создайте свой или соберите из истории Claude Code.
              </p>
            )
          ) : (
            <ul className="template-list" data-testid="tpl-list">
              {shown.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`template-row${editing?.id === t.id ? ' is-selected' : ''}`}
                    data-testid="tpl-item"
                    onClick={() => open({ id: t.id, title: t.title, body: t.body })}
                  >
                    <span className="template-row-title">{t.title}</span>
                    {t.origin === 'harvest' && <span className="template-row-tag">из истории</span>}
                    <span className="template-row-preview">{t.body.split('\n')[0]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
