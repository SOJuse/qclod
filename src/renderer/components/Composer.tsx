import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon, ImageOff, Paperclip, Square, X } from 'lucide-react'
import type {
  Attachment,
  CommandInfo,
  EffortLevel,
  ModelOption,
  PromptTemplate,
  SessionStatus
} from '../../shared/types'
import { markRemote, withLocalCommands } from '../../shared/commandFilter'
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
import { applyTemplateFromSlash, insertTemplate } from '../input/templates'
import { hint, hintKeys } from '../app/shortcuts'
import {
  acceptCommand,
  acceptTemplate,
  completeCommand,
  bareLocalStep,
  bareRemoteToggle,
  findSlashQuery,
  slashItems,
  stepItems,
  type SlashOutcome,
  type SlashStep
} from '../input/slash'
import { longFieldClasses } from '../ui/longText'
import { InlineMenu, type InlineMenuItem } from './InlineMenu'
import { SlashMenu } from './SlashMenu'
import { MicButton } from './composer/MicButton'
import { useVoiceCaret, VoiceMenu, VoiceTentative } from './composer/VoiceParts'
import type { VoiceControls } from './composer/voice'
import './Composer.css'

interface Props {
  tabId: string
  status: SessionStatus
  draft: string
  /** What the person sent in this tab, oldest first: the source of ↑/↓ history. */
  sentTexts: string[]
  attachments: PendingAttachment[]
  fileIndex: string[]
  /** What the session offers after `/`, as it sent it. */
  commands: CommandInfo[]
  recentCommands: string[]
  /** этап 7: the owner's templates, offered after the commands in the `/` list. */
  templates?: PromptTemplate[]
  /** этап 7: text to put in at the caret (a template from Ctrl+K); each nonce once. */
  insertRequest?: { text: string; nonce: number } | null
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
  /** Switch Remote Control for this tab (/remote-control, /rc). */
  onToggleRemote?: () => void
  /** Why Remote Control cannot be switched on here; its command shows it, greyed out. */
  remoteBlockedText?: string | null
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
  /** A long draft held back after the window froze and was reloaded (state/heldDrafts.ts). */
  heldDraft?: boolean
  onInsertHeldDraft?: () => void
  /** Этап 5's voice input; without it the microphone is Windows dictation (Win+H). */
  voice?: VoiceControls
  /** Set when nothing can be sent from here at all (a chat of a removed server, R9): the field says why and is off. */
  blockedText?: string | null
}

const MAX_MATCHES = 8

/** A pasted image's chip carries its thumbnail; a failed one says so in colour and words. */
function chipClass(item: PendingAttachment): string {
  // A server chat's file (stage 6): going up, or failed to.
  if (item.kind !== 'image') {
    return `composer-chip${item.error ? ' is-error' : ''}${item.uploading ? ' is-uploading' : ''}`
  }
  return `composer-chip is-image${item.error ? ' is-error' : ''}`
}

const COMMANDS_STEP: SlashStep = { kind: 'commands' }
const NO_TEMPLATES: PromptTemplate[] = []

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
 * Above the field after the watchdog reloaded a frozen window: the long draft
 * was kept but not put back, in case it is what froze it. «Вставить» puts it
 * back.
 */
export function HeldDraftStrip({ onInsert }: { onInsert: () => void }): JSX.Element {
  return (
    <div className="composer-held" data-testid="composer-held" role="status">
      <span>Окно зависло на длинном тексте. Черновик сохранён — вставить его снова?</span>
      <button type="button" className="is-primary" data-testid="composer-held-insert" onClick={onInsert}>
        Вставить
      </button>
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
  sentTexts,
  attachments,
  fileIndex,
  commands,
  recentCommands,
  templates = NO_TEMPLATES,
  insertRequest = null,
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
  onToggleRemote,
  remoteBlockedText = null,
  onSetModel,
  onSetEffort,
  onCycleMode,
  onRestart,
  canRetry = false,
  onRetry,
  onPickFiles,
  onImagePrepared,
  heldDraft = false,
  onInsertHeldDraft,
  voice,
  blockedText = null
}: Props): JSX.Element {
  const field = useRef<HTMLTextAreaElement | null>(null)
  const histories = useRef(new Map<string, InputHistory>())
  const [caret, setCaretState] = useState(0)
  // The voice hears where the caret is: its next phrase goes there (этап 5).
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const setCaret = useCallback((at: number): void => {
    setCaretState(at)
    voiceRef.current?.caretMoved(at)
  }, [])
  useVoiceCaret(voice, field, setCaretState)
  /** Where the caret (or a selection: a template's {{…}}) goes once a text we set ourselves is in the field. */
  const pendingCaret = useRef<{ start: number; end: number } | null>(null)
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
      existing = new InputHistory(sentTexts)
      histories.current.set(tabId, existing)
    }
    return existing
  })()
  // The tab's own messages are the source; the list follows them as they come.
  useEffect(() => history.setEntries(sentTexts), [history, sentTexts])

  const available = markRemote(withLocalCommands(commands), remoteBlockedText)

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
    const items = slashItems(available, templates, slash.query, recentCommands)
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
    // Plus the sideways scrollbar a long unwrapped paragraph has (Composer.css .is-long).
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 260)}px`
    // Placed before the next keystroke can land: a frame later, fast typing
    // has already gone in at the old spot.
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current.start, pendingCaret.current.end)
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

  // этап 7: a template from Ctrl+K goes in where the caret (or the selection)
  // was when the palette took the focus; its first {{…}} comes selected.
  const doneInsert = useRef(insertRequest?.nonce ?? 0)
  useEffect(() => {
    if (!insertRequest || insertRequest.nonce === doneInsert.current) return
    doneInsert.current = insertRequest.nonce
    const el = field.current
    const start = el ? el.selectionStart : draft.length
    const end = el ? el.selectionEnd : draft.length
    const result = insertTemplate(draft, start, end, insertRequest.text)
    history.edit()
    replaceDraft(result.text, result.selStart, result.selEnd)
    el?.focus()
    // Only a new request runs this; the draft and the field are read as they are now.
  }, [insertRequest])

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

  // A crashed session cannot carry a message: accepting one would show it in
  // the ribbon, set the tab working, and deliver it nowhere (spec 6.10).
  const dead = status === 'error' || (blockedText !== undefined && blockedText !== null)
  const crashed = status === 'error'

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
      pendingCaret.current = { start: text.length, end: text.length }
      onDraftChange(text)
      setCaret(text.length)
      return
    }
    // «/remote-control» typed whole is the switch too, and never reaches the
    // session. Where it cannot work the draft stays, and the list says why.
    if (onToggleRemote && bareRemoteToggle(draft)) {
      if (remoteBlockedText) return
      onDraftChange('')
      setCaret(0)
      onToggleRemote()
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
    // Cleared now; a message the tab could not take comes back (onSubmit).
    onDraftChange('')
    onAttachmentsChange([])
    onSubmit(text, ready)
  }, [draft, attachments, history, onDraftChange, onAttachmentsChange, onSubmit, onToggleRemote, remoteBlockedText])

  // A failed image cancels the waiting send and leaves the text and its error
  // chip in place: only another Enter sends without the image.
  const queued = queuedSendStep(sendWhenReady, attachments, dead)
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
      caretOnFirstLine: el ? !draft.slice(0, el.selectionStart).includes('\n') : true,
      caretOnLastLine: el ? !draft.slice(el.selectionEnd).includes('\n') : true
    }
  }

  /** Replaces the field's text and puts the caret where the next typing goes. */
  function replaceDraft(text: string, at = text.length, selEnd = at): void {
    // The same text re-renders nothing, so the caret is placed right here.
    if (text === draft) field.current?.setSelectionRange(at, selEnd)
    else pendingCaret.current = { start: at, end: selEnd }
    onDraftChange(text)
    setCaret(at)
  }

  function runOutcome(outcome: SlashOutcome): void {
    switch (outcome.kind) {
      case 'none':
        return
      case 'send':
        replaceDraft('')
        onSendCommand(outcome.text)
        return
      case 'fill':
        replaceDraft(outcome.text)
        return
      case 'remote':
        replaceDraft('')
        onToggleRemote?.()
        return
      case 'history':
        replaceDraft('')
        onOpenHistory()
        return
      case 'step':
        setStep(outcome.step)
        replaceDraft(outcome.text)
        return
      case 'template': {
        const result = applyTemplateFromSlash(draft, caret, outcome.body)
        replaceDraft(result.text, result.selStart, result.selEnd)
        return
      }
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
    const template = acceptTemplate(templates, item.id)
    if (template.kind !== 'none') {
      runOutcome(template)
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
        const line = action === 'historyPrev' ? history.prev(draft) : history.next()
        if (line === undefined) return
        ev.preventDefault()
        // Going back lands at the start so ↑ goes on through the past; coming
        // forward lands at the end so ↓ does.
        replaceDraft(line, action === 'historyPrev' ? 0 : line.length)
        return
      }
    }
  }

  const busy = status === 'busy' || status === 'waiting'
  const fieldClass = useMemo(() => ['composer-input', 'ring-on-parent', ...longFieldClasses(draft)].join(' '), [draft])

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
      {crashed && <DeadStrip canRetry={canRetry} onRetry={onRetry} onRestart={onRestart} />}

      {heldDraft && onInsertHeldDraft && (
        <HeldDraftStrip
          onInsert={() => {
            onInsertHeldDraft()
            field.current?.focus()
          }}
        />
      )}

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

      <div className="composer-row ring-host">
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

        {/* Beside the clip, not after the field: Tab from the field still goes to «Отправить». */}
        <MicButton
          {...(voice ? { voice } : {})}
          disabled={dead}
          onFallback={() => {
            // Windows types into whatever has the focus, so the field gets it first.
            field.current?.focus()
            void window.qclod.startVoice()
          }}
        />
        <VoiceMenu voice={voice} field={field} />

        <textarea
          ref={field}
          className={fieldClass}
          data-testid="composer-input"
          data-composer-input=""
          aria-autocomplete="list"
          aria-expanded={popupOpen}
          aria-controls={popupOpen ? menuId : undefined}
          aria-activedescendant={popupOpen ? `${menuId}-${selected}` : undefined}
          rows={1}
          disabled={dead}
          placeholder={
            blockedText ? blockedText : dead ? 'Сессия прервалась — запустите заново' : busy ? 'Агент работает — Esc прерывает' : 'Что делаем?'
          }
          value={draft}
          onChange={(ev) => {
            history.edit()
            onDraftChange(ev.target.value)
            setCaret(ev.target.selectionStart)
          }}
          onKeyUp={(ev) => setCaret(ev.currentTarget.selectionStart)}
          onClick={(ev) => setCaret(ev.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(ev) => {
            const items = attachmentsFromClipboard(ev.clipboardData, window.qclod.pathForFile)
            if (items.length > 0) {
              // A file copied in Explorer pastes nothing as text; it is an
              // attachment, and the paste itself must not also insert a name.
              ev.preventDefault()
              addAttachments(items)
              return
            }
            // The browser lays the field out as part of the paste itself,
            // before React hears of it: a paragraph that will be too long to
            // wrap is unwrapped now, or that one layout freezes the window.
            const el = ev.currentTarget
            const pasted = ev.clipboardData.getData('text/plain')
            const after = draft.slice(0, el.selectionStart) + pasted + draft.slice(el.selectionEnd)
            el.classList.add(...longFieldClasses(after))
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
        <VoiceTentative voice={voice} />
      </div>
    </div>
  )
}
