import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon, ImageOff, Paperclip, Square, X } from 'lucide-react'
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
  isPreparing,
  materialize,
  prepareAttachment,
  queuedSendStep,
  type PendingAttachment,
  type PendingImage
} from '../input/attachments'
import { applyMention, findMentionQuery } from '../input/mentions'
import { InputHistory } from '../input/history'
import { hint, hintKeys } from '../app/shortcuts'
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
  /** main has answered for a pasted image: its bounded copy, or an error. */
  onImagePrepared: (file: File, patch: Pick<PendingImage, 'prepared' | 'error'>) => void
}

const MAX_MATCHES = 8

/** A pasted image's chip carries its thumbnail; a failed one says so in colour and words. */
function chipClass(item: PendingAttachment): string {
  if (item.kind !== 'image') return 'composer-chip'
  return `composer-chip is-image${item.error ? ' is-error' : ''}`
}

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
          <button type="button" className="is-primary" data-testid="composer-retry" title="Повторить последний запрос в этом же разговоре" onClick={onRetry}>
            Повторить
          </button>
          <button type="button" data-testid="composer-restart" title="Начать новую сессию в этой папке" onClick={onRestart}>
            Начать заново
          </button>
        </>
      ) : (
        <button type="button" data-testid="composer-restart" title={hint('Запустить сессию заново', 'restart')} onClick={onRestart}>
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
  onPickFiles,
  onImagePrepared
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
      // An image is shown at once as «Готовлю снимок…»; main then scales it
      // to what the API takes and the chip becomes its thumbnail.
      for (const item of items) {
        if (item.kind !== 'image' || !item.file || !isPreparing(item)) continue
        const file = item.file
        void prepareAttachment(item, window.qclod.prepareImage).then((patch) => onImagePrepared(file, patch))
      }
    },
    [attachments, onAttachmentsChange, onImagePrepared]
  )

  /** Enter pressed while an image was still being prepared: send once it is. */
  const [sendWhenReady, setSendWhenReady] = useState(false)

  const submit = useCallback(async (): Promise<void> => {
    // Every way out of here leaves no send waiting, unless it is the one
    // below that decides to wait.
    setSendWhenReady(false)
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
    if (attachments.some(isPreparing)) {
      setSendWhenReady(true)
      return
    }
    const ready = materialize(attachments)
    // Nothing left to send: only a failed image, which stays to be seen.
    if (!text && ready.length === 0) return
    history.push(draft)
    onDraftChange('')
    onAttachmentsChange([])
    onSubmit(text, ready)
  }, [draft, attachments, history, onDraftChange, onAttachmentsChange, onSubmit])

  // A failed image cancels the waiting send and leaves the text and its error
  // chip in place: only another Enter sends without the image.
  const queued = queuedSendStep(sendWhenReady, attachments)
  useEffect(() => {
    if (queued === 'send') void submit()
    else if (queued === 'cancel') setSendWhenReady(false)
  }, [queued, submit])

  // A different tab's field does not inherit a send that was waiting here.
  useEffect(() => setSendWhenReady(false), [tabId])

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
            <span
              key={`${index}-${item.kind === 'file' ? item.path : 'image'}`}
              className={chipClass(item)}
              data-testid="composer-chip"
              title={attachmentLabel(item)}
            >
              {item.kind === 'image' && item.prepared && !item.prepared.thumbnail ? (
                <ImageIcon size={14} aria-hidden="true" />
              ) : item.kind === 'image' && item.prepared ? (
                <img
                  className="composer-chip-thumb"
                  data-testid="composer-chip-thumb"
                  src={item.prepared.thumbnail}
                  alt=""
                />
              ) : item.kind === 'image' && !item.error ? (
                <span className="composer-chip-wait" aria-hidden="true" />
              ) : null}
              {item.kind === 'image' && item.error ? (
                <ImageOff size={14} aria-hidden="true" />
              ) : null}
              <span className="composer-chip-label">{attachmentLabel(item)}</span>
              <button
                type="button"
                data-testid="composer-chip-remove"
                aria-label={item.kind === 'image' ? 'Убрать снимок' : `Убрать ${attachmentLabel(item)}`}
                title={item.kind === 'image' ? 'Убрать снимок' : `Убрать ${attachmentLabel(item)}`}
                onClick={() => {
                  // Taking something away changes the message: a send that
                  // was waiting does not go on its own.
                  setSendWhenReady(false)
                  onAttachmentsChange(attachments.filter((_, i) => i !== index))
                }}
              >
                <X size={12} aria-hidden="true" />
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
          title="Прикрепить файлы"
          onClick={onPickFiles}
        >
          <Paperclip size={16} aria-hidden="true" />
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
          title={busy ? hintKeys('Прервать', 'Esc') : hintKeys('Отправить', 'Enter')}
          disabled={dead}
          onClick={() => (busy ? onInterrupt() : void submit())}
        >
          {busy ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
