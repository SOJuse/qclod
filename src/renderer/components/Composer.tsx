import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  Attachment,
  CommandInfo,
  EffortLevel,
  ModelOption,
  SessionStatus
} from '../../shared/types'
import { withLocalCommands } from '../../shared/commandFilter'
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
import {
  acceptCommand,
  commandItems,
  completeCommand,
  bareLocalStep,
  findSlashQuery,
  stepItems,
  type SlashOutcome,
  type SlashStep
} from '../input/slash'
import { InlineMenu, type InlineMenuItem } from './InlineMenu'
import { SlashMenu } from './SlashMenu'
import './Composer.css'

interface Props {
  tabId: string
  status: SessionStatus
  draft: string
  attachments: PendingAttachment[]
  fileIndex: string[]
  /** What the session offers after `/`, as it sent it. */
  commands: CommandInfo[]
  recentCommands: string[]
  /** For the second step of /model and /effort. */
  models: ModelOption[]
  model: string | null
  effort: EffortLevel | null
  /** The tab has a running session; /model and /effort need one to apply. */
  started: boolean
  /** Bumped by whoever took focus away, to hand it back. */
  focusToken: number
  /** False for a pane that is on screen but not the one being typed into. */
  autoFocus?: boolean
  onDraftChange: (text: string) => void
  onAttachmentsChange: (items: PendingAttachment[]) => void
  onSubmit: (text: string, attachments: Attachment[]) => void
  onInterrupt: () => void
  /** A slash command picked from the list, to send as it is. */
  onSendCommand: (text: string) => void
  onCommandUsed: (name: string) => void
  onOpenHistory: () => void
  onSetModel: (model: string) => void
  onSetEffort: (level: EffortLevel) => void
  onCycleMode: () => void
  onRestart: () => void
  /** Set when the session never reached its conversation and can open it again. */
  canRetry?: boolean
  onRetry: () => void
  onPickFiles: () => void
}

const MAX_MATCHES = 8

const COMMANDS_STEP: SlashStep = { kind: 'commands' }

type Menu =
  | { kind: 'none' }
  | { kind: 'mention'; start: number; items: InlineMenuItem[] }
  | { kind: 'slash'; step: SlashStep; key: string; items: InlineMenuItem[]; initial: number }

/**
 * The line above a dead session's input. When the session never got to its
 * conversation, «Повторить» opens that same conversation and comes first;
 * «Начать заново» lets it go.
 */
export function DeadStrip({
  canRetry = false,
  onRetry,
  onRestart
}: {
  canRetry?: boolean
  onRetry: () => void
  onRestart: () => void
}): JSX.Element {
  return (
    <div className="composer-dead" data-testid="composer-dead">
      <span>Сессия прервалась</span>
      {canRetry ? (
        <>
          <button type="button" className="is-primary" data-testid="composer-retry" onClick={onRetry}>
            Повторить
          </button>
          <button type="button" data-testid="composer-restart" onClick={onRestart}>
            Начать заново
          </button>
        </>
      ) : (
        <button type="button" data-testid="composer-restart" onClick={onRestart}>
          Запустить заново
        </button>
      )}
    </div>
  )
}

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
  commands,
  recentCommands,
  models,
  model,
  effort,
  started,
  focusToken,
  autoFocus = true,
  onDraftChange,
  onAttachmentsChange,
  onSubmit,
  onInterrupt,
  onSendCommand,
  onCommandUsed,
  onOpenHistory,
  onSetModel,
  onSetEffort,
  onCycleMode,
  onRestart,
  canRetry = false,
  onRetry,
  onPickFiles
}: Props): JSX.Element {
  const field = useRef<HTMLTextAreaElement | null>(null)
  const histories = useRef(new Map<string, InputHistory>())
  const [caret, setCaret] = useState(0)
  /** Where the caret goes once a text we set ourselves is in the field. */
  const pendingCaret = useRef<number | null>(null)
  /** The row picked with the arrows, remembered for the list it was picked in. */
  const [selection, setSelection] = useState({ key: '', index: 0 })
  /** The second list of /model or /effort, once its command was chosen. */
  const [step, setStep] = useState<SlashStep>(COMMANDS_STEP)
  /** The text Esc closed the list on; typing anything brings the list back. */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const menuId = useId()

  const history = ((): InputHistory => {
    let existing = histories.current.get(tabId)
    if (!existing) {
      existing = new InputHistory()
      histories.current.set(tabId, existing)
    }
    return existing
  })()

  const available = withLocalCommands(commands)

  const menu = ((): Menu => {
    if (dismissedFor === draft) return { kind: 'none' }

    const mention = findMentionQuery(draft, caret)
    if (mention) {
      const needle = mention.query.toLowerCase()
      const items = fileIndex
        .filter((path) => path.toLowerCase().includes(needle))
        .slice(0, MAX_MATCHES)
        .map((path): InlineMenuItem => {
          const slash = path.lastIndexOf('/')
          return {
            id: path,
            primary: path.slice(slash + 1),
            ...(slash > 0 ? { secondary: path.slice(0, slash) } : {})
          }
        })
      if (items.length > 0) return { kind: 'mention', start: mention.start, items }
    }

    // The second list stays while the field still reads «/model …».
    const prefix = `/${step.kind} `
    if (step.kind !== 'commands' && draft.startsWith(prefix) && !draft.includes('\n')) {
      const query = draft.slice(prefix.length)
      const items =
        stepItems({ kind: step.kind }, { models, model, effort, started }, query)
      const current = step.kind === 'model' ? model : effort
      const initial = Math.max(0, items.findIndex((item) => item.id === current))
      return { kind: 'slash', step, key: `${step.kind}:${query}`, items, initial }
    }

    const slash = findSlashQuery(draft, caret)
    if (!slash) return { kind: 'none' }
    const items = commandItems(available, slash.query, recentCommands)
    return { kind: 'slash', step: COMMANDS_STEP, key: `commands:${slash.query}`, items, initial: 0 }
  })()
  const menuItems = menu.kind === 'none' ? [] : menu.items
  const menuKey =
    menu.kind === 'mention' ? `mention:${draft}:${caret}` : menu.kind === 'slash' ? menu.key : ''
  const popupOpen = menuItems.length > 0
  const selected = Math.min(
    selection.key === menuKey ? selection.index : menu.kind === 'slash' ? menu.initial : 0,
    Math.max(0, menuItems.length - 1)
  )

  // The field grows with its content instead of scrolling a three-line box.
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
    // Placed before the next keystroke can land: a frame later, fast typing
    // has already gone in at the old spot.
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [draft])

  // Switching tabs, or closing something that stole focus, puts the cursor
  // back where the work happens.
  useEffect(() => {
    // A second pane must never take focus by itself: the focused pane would
    // hand it straight back, and the two would trade it forever.
    if (!autoFocus) return
    field.current?.focus()
  }, [tabId, focusToken, autoFocus])

  // Once «/model » is edited away, the second list is done with.
  useEffect(() => {
    if (step.kind !== 'commands' && !draft.startsWith(`/${step.kind} `)) setStep(COMMANDS_STEP)
  }, [draft, step])

  // A list belongs to the tab it was opened in.
  useEffect(() => {
    setStep(COMMANDS_STEP)
    setDismissedFor(null)
  }, [tabId])

  const addAttachments = useCallback(
    (items: PendingAttachment[]) => {
      if (items.length === 0) return
      onAttachmentsChange([...attachments, ...items])
    },
    [attachments, onAttachmentsChange]
  )

  const submit = useCallback(async (): Promise<void> => {
    // A bare «/model» is ours: it opens the list again rather than going to
    // the session, where it would do nothing.
    const local = bareLocalStep(draft)
    if (local) {
      setStep(local)
      setDismissedFor(null)
      const text = `/${local.kind} `
      if (text === draft) return
      pendingCaret.current = text.length
      onDraftChange(text)
      setCaret(text.length)
      return
    }
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

  /** Replaces the field's text and puts the caret where the next typing goes. */
  function replaceDraft(text: string, at = text.length): void {
    // The same text re-renders nothing, so the caret is placed right here.
    if (text === draft) field.current?.setSelectionRange(at, at)
    else pendingCaret.current = at
    onDraftChange(text)
    setCaret(at)
  }

  function runOutcome(outcome: SlashOutcome): void {
    switch (outcome.kind) {
      case 'none':
        return
      case 'send':
        history.push(outcome.text)
        replaceDraft('')
        onSendCommand(outcome.text)
        return
      case 'fill':
        replaceDraft(outcome.text)
        return
      case 'history':
        replaceDraft('')
        onOpenHistory()
        return
      case 'step':
        setStep(outcome.step)
        replaceDraft(outcome.text)
        return
    }
  }

  /**
   * Enter or a click runs the row; Tab only writes it out. A file, and a value
   * in the second step, are simply taken either way — there is nothing to run.
   */
  function pick(item: InlineMenuItem | undefined, complete = false): void {
    if (!item || item.disabledReason || menu.kind === 'none') return
    if (menu.kind === 'mention') {
      const result = applyMention(draft, menu.start, caret, item.id)
      replaceDraft(result.text, result.caret)
      return
    }
    if (menu.step.kind !== 'commands') {
      if (menu.step.kind === 'model') onSetModel(item.id)
      else onSetEffort(item.id as EffortLevel)
      setStep(COMMANDS_STEP)
      replaceDraft('')
      return
    }
    const command = available.find((c) => c.name === item.id)
    if (!command) return
    const outcome = complete ? completeCommand(command) : acceptCommand(command)
    if (!complete && outcome.kind !== 'none') onCommandUsed(command.name)
    runOutcome(outcome)
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const action = resolveComposerKey(
      {
        key: ev.key,
        code: ev.code,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        isComposing: ev.nativeEvent.isComposing,
        keyCode: ev.keyCode
      },
      context()
    )

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
        // The list goes; the text stays exactly as typed.
        ev.preventDefault()
        setDismissedFor(draft)
        setStep(COMMANDS_STEP)
        return

      case 'popupNav': {
        ev.preventDefault()
        const count = menuItems.length
        const next = ev.key === 'ArrowUp' ? selected - 1 : selected + 1
        setSelection({ key: menuKey, index: (next + count) % count })
        return
      }

      case 'popupAccept':
      case 'popupComplete':
        // For a file, Tab takes it as Enter always did.
        ev.preventDefault()
        pick(menuItems[selected], action === 'popupComplete')
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
      {dead && <DeadStrip canRetry={canRetry} onRetry={onRetry} onRestart={onRestart} />}

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

      {menu.kind === 'mention' && (
        <InlineMenu
          items={menuItems}
          selected={selected}
          onPick={(item) => pick(item)}
          id={menuId}
          testId="mention-popup"
          itemTestId="mention-item"
        />
      )}
      {menu.kind === 'slash' && (
        <SlashMenu
          id={menuId}
          step={menu.step}
          items={menuItems}
          selected={selected}
          onPick={(item) => pick(item)}
        />
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
          data-composer-input=""
          aria-autocomplete="list"
          aria-expanded={popupOpen}
          aria-controls={popupOpen ? menuId : undefined}
          aria-activedescendant={popupOpen ? `${menuId}-${selected}` : undefined}
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
