import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment, SessionStatus } from '../../shared/types'
import { resolveComposerKey, type ComposerContext } from '../input/keyPrecedence'
import {
  attachmentLabel,
  attachmentsFromClipboard,
  attachmentsFromDrop,
  materialize,
  type PendingAttachment
} from '../input/attachments'
import { applyMention, findMentionQuery } from '../input/mentions'
import { InputHistory } from '../input/history'
import { MentionPopup } from './MentionPopup'
import './Composer.css'

interface Props {
  tabId: string
  status: SessionStatus
  draft: string
  attachments: PendingAttachment[]
  fileIndex: string[]
  /** Bumped by whoever took focus away, to hand it back. */
  focusToken: number
  onDraftChange: (text: string) => void
  onAttachmentsChange: (items: PendingAttachment[]) => void
  onSubmit: (text: string, attachments: Attachment[]) => void
  onInterrupt: () => void
  onOpenPalette: () => void
  onCycleMode: () => void
  onRestart: () => void
  onPickFiles: () => void
}

const MAX_MATCHES = 8

/**
 * The one input line.
 *
 * v1 had two — ours and the CLI's own — and the user's verdict on that was
 * «мега неудобная»: focus jumped, text landed in whichever field happened to
 * be listening. There is one field now, it is a plain textarea, and every
 * native editing key is left alone (spec 6.3).
 */
export function Composer({
  tabId,
  status,
  draft,
  attachments,
  fileIndex,
  focusToken,
  onDraftChange,
  onAttachmentsChange,
  onSubmit,
  onInterrupt,
  onOpenPalette,
  onCycleMode,
  onRestart,
  onPickFiles
}: Props): JSX.Element {
  const field = useRef<HTMLTextAreaElement | null>(null)
  const histories = useRef(new Map<string, InputHistory>())
  const [mentionIndex, setMentionIndex] = useState(0)
  const [caret, setCaret] = useState(0)

  const history = ((): InputHistory => {
    let existing = histories.current.get(tabId)
    if (!existing) {
      existing = new InputHistory()
      histories.current.set(tabId, existing)
    }
    return existing
  })()

  const query = findMentionQuery(draft, caret)
  const matches = query
    ? fileIndex
        .filter((path) => path.toLowerCase().includes(query.query.toLowerCase()))
        .slice(0, MAX_MATCHES)
    : []
  const popupOpen = matches.length > 0

  // The field grows with its content instead of scrolling a three-line box.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [draft])

  // Switching tabs, or closing something that stole focus, puts the cursor
  // back where the work happens.
  useEffect(() => {
    field.current?.focus()
  }, [tabId, focusToken])

  const addAttachments = useCallback(
    (items: PendingAttachment[]) => {
      if (items.length === 0) return
      onAttachmentsChange([...attachments, ...items])
    },
    [attachments, onAttachmentsChange]
  )

  const submit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    const ready = await materialize(attachments)
    history.push(draft)
    onDraftChange('')
    onAttachmentsChange([])
    onSubmit(text, ready)
  }, [draft, attachments, history, onDraftChange, onAttachmentsChange, onSubmit])

  function context(): ComposerContext {
    const el = field.current
    return {
      text: draft,
      popupOpen,
      hasSelection: el ? el.selectionStart !== el.selectionEnd : false,
      hasAttachments: attachments.length > 0,
      caretAtStart: el ? el.selectionStart === 0 : true,
      caretAtEnd: el ? el.selectionEnd === draft.length : true
    }
  }

  function acceptMention(path: string): void {
    if (!query) return
    const result = applyMention(draft, query.start, caret, path)
    onDraftChange(result.text)
    requestAnimationFrame(() => {
      field.current?.setSelectionRange(result.caret, result.caret)
      setCaret(result.caret)
    })
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const action = resolveComposerKey(ev as unknown as Parameters<typeof resolveComposerKey>[0], context())

    switch (action) {
      case 'native':
      case 'insert':
      case 'caret':
      case 'newline':
      case 'openMentions':
        return

      case 'interrupt':
        ev.preventDefault()
        onInterrupt()
        return

      case 'closePopup':
        ev.preventDefault()
        setMentionIndex(0)
        setCaret(-1)
        return

      case 'popupNav':
        ev.preventDefault()
        setMentionIndex((index) => {
          const next = ev.key === 'ArrowUp' ? index - 1 : index + 1
          return (next + matches.length) % matches.length
        })
        return

      case 'popupAccept':
        ev.preventDefault()
        acceptMention(matches[mentionIndex] ?? matches[0] ?? '')
        setMentionIndex(0)
        return

      case 'openPalette':
        ev.preventDefault()
        onOpenPalette()
        return

      case 'cyclePermissionMode':
        // Shift+Tab cycles the mode as it does in the terminal, and Tab never
        // moves focus out of the field.
        ev.preventDefault()
        onCycleMode()
        return

      case 'submit':
        ev.preventDefault()
        if (dead) return
        void submit()
        return

      case 'historyPrev':
      case 'historyNext': {
        const line = action === 'historyPrev' ? history.prev() : history.next()
        if (line === undefined || line === null) return
        ev.preventDefault()
        onDraftChange(line)
        return
      }
    }
  }

  const busy = status === 'busy' || status === 'waiting'
  // A crashed session cannot carry a message: accepting one would show it in
  // the ribbon, set the tab working, and deliver it nowhere (spec 6.10).
  const dead = status === 'error'

  return (
    <div
      className="composer"
      data-testid="composer"
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={(ev) => {
        ev.preventDefault()
        addAttachments(
          attachmentsFromDrop(Array.from(ev.dataTransfer.files), window.qclod.pathForFile)
        )
      }}
    >
      {dead && (
        <div className="composer-dead" data-testid="composer-dead">
          <span>Сессия прервалась</span>
          <button type="button" data-testid="composer-restart" onClick={onRestart}>
            Запустить заново
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-chips" data-testid="composer-chips">
          {attachments.map((item, index) => (
            <span key={`${index}-${attachmentLabel(item)}`} className="composer-chip" data-testid="composer-chip">
              {attachmentLabel(item)}
              <button
                type="button"
                data-testid="composer-chip-remove"
                aria-label={`Убрать ${attachmentLabel(item)}`}
                onClick={() => onAttachmentsChange(attachments.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {popupOpen && (
        <MentionPopup items={matches} selected={mentionIndex} onPick={acceptMention} />
      )}

      <div className="composer-row">
        <button
          type="button"
          className="composer-clip"
          data-testid="composer-clip"
          aria-label="Прикрепить файлы"
          onClick={onPickFiles}
        >
          📎
        </button>

        <textarea
          ref={field}
          className="composer-input"
          data-testid="composer-input"
          rows={1}
          disabled={dead}
          placeholder={
            dead ? 'Сессия прервалась — запустите заново' : busy ? 'Агент работает — Esc прерывает' : 'Что делаем?'
          }
          value={draft}
          onChange={(ev) => {
            onDraftChange(ev.target.value)
            setCaret(ev.target.selectionStart)
          }}
          onKeyUp={(ev) => setCaret(ev.currentTarget.selectionStart)}
          onClick={(ev) => setCaret(ev.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(ev) => {
            const items = attachmentsFromClipboard(ev.clipboardData, window.qclod.pathForFile)
            if (items.length === 0) return
            // A file copied in Explorer pastes nothing as text; it is an
            // attachment, and the paste itself must not also insert a name.
            ev.preventDefault()
            addAttachments(items)
          }}
        />

        <button
          type="button"
          className={`composer-send${busy ? ' is-busy' : ''}`}
          data-testid={busy ? 'composer-stop' : 'composer-send'}
          aria-label={busy ? 'Прервать' : 'Отправить'}
          disabled={dead}
          onClick={() => (busy ? onInterrupt() : void submit())}
        >
          {busy ? '■' : '↑'}
        </button>
      </div>
    </div>
  )
}
