import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ClipboardEventBase,
  type KeyboardEvent
} from 'react'
import { chunkForPty } from '../input/encode'
import { InputHistory } from '../input/history'
import { resolveComposerKey } from '../input/keyPrecedence'
import { nextPassthrough } from '../input/passthrough'
import { useAppStore } from '../state/useAppStore'
import { toSequence } from '../input/keySequence'
import { applyMention, findMentionQuery } from '../input/mentions'
import { filterPaths } from '../../shared/fuzzy'
import { MentionPopup } from './MentionPopup'
import type { TabId } from '../../shared/types'
import './Composer.css'

interface Props {
  tabId: TabId
  focused: boolean
  menuActive: boolean
  onRequestFocus: () => void
  onToggleFocus: () => void
}

const MAX_ROWS = 12

export function Composer({
  tabId,
  focused,
  menuActive,
  onRequestFocus,
  onToggleFocus
}: Props): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const draft = useAppStore((s) => s.draftByTab[tabId] ?? '')
  const setDraft = useAppStore((s) => s.setDraft)
  const markTyped = useAppStore((s) => s.markTyped)
  const markHandedOff = useAppStore((s) => s.markHandedOff)

  // One history per tab, kept across re-renders.
  const histories = useRef(new Map<TabId, InputHistory>())
  const history = useMemo(() => {
    let existing = histories.current.get(tabId)
    if (!existing) {
      existing = new InputHistory()
      histories.current.set(tabId, existing)
    }
    return existing
  }, [tabId])

  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState<string[]>([])
  const [matches, setMatches] = useState<string[]>([])
  const [selected, setSelected] = useState(0)

  const passthrough = nextPassthrough(false, draft)
  const mention = passthrough ? null : findMentionQuery(draft, caret)
  const popupOpen = mention !== null && matches.length > 0

  useEffect(() => {
    if (focused) areaRef.current?.focus()
  }, [focused, tabId])

  // The project index is built once per tab, the first time it is needed.
  useEffect(() => {
    if (mention === null || index.length > 0) return
    let cancelled = false
    void window.qclod.fileIndex(tabId).then((paths) => {
      if (!cancelled) setIndex(paths)
    })
    return () => {
      cancelled = true
    }
  }, [index.length, mention, tabId])

  useEffect(() => {
    if (mention === null) {
      setMatches([])
      return
    }
    setMatches(filterPaths(index, mention.query, 12))
    setSelected(0)
  }, [index, mention?.query, mention === null])

  // Grow with the content, up to a ceiling.
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 18
    area.style.height = `${Math.min(area.scrollHeight, lineHeight * MAX_ROWS)}px`
  }, [draft])

  const send = useCallback(
    (text: string) => {
      if (text.trim() === '') return
      for (const chunk of chunkForPty(text)) void window.qclod.write(tabId, chunk)
      void window.qclod.write(tabId, '\r')
      history.push(text)
      setDraft(tabId, '')
      markHandedOff()
    },
    [history, markHandedOff, setDraft, tabId]
  )

  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>) => {
      const area = ev.currentTarget
      const action = resolveComposerKey(ev, {
        text: draft,
        passthrough,
        popupOpen,
        menuActive,
        hasSelection: area.selectionStart !== area.selectionEnd,
        caretAtStart: area.selectionStart === 0,
        caretAtEnd: area.selectionEnd === draft.length
      })

      switch (action) {
        case 'insert':
        case 'caret':
        case 'paste':
        case 'copy':
        case 'newline':
          // Let the textarea do what a textarea does.
          markTyped()
          return
        case 'popupNav': {
          ev.preventDefault()
          const step = ev.key === 'ArrowUp' ? -1 : 1
          setSelected((current) => (current + step + matches.length) % matches.length)
          return
        }
        case 'popupAccept': {
          ev.preventDefault()
          if (!mention) return
          const result = applyMention(draft, mention.start, caret, matches[selected])
          setDraft(tabId, result.text)
          setCaret(result.caret)
          requestAnimationFrame(() => areaRef.current?.setSelectionRange(result.caret, result.caret))
          return
        }
        case 'closePopup':
          ev.preventDefault()
          setMatches([])
          return
        case 'toggleFocus':
          ev.preventDefault()
          onToggleFocus()
          return
        case 'submit':
          ev.preventDefault()
          send(draft)
          return
        case 'toPty': {
          ev.preventDefault()
          const sequence = toSequence(ev)
          if (sequence !== '') void window.qclod.write(tabId, sequence)
          // In passthrough the CLI owns the text, but our field has to track it
          // so the indicator and the exit condition stay truthful.
          if (passthrough || ev.key === '/') {
            applyPassthroughEcho(ev, draft, (next) => setDraft(tabId, next))
          }
          return
        }
        case 'historyPrev': {
          ev.preventDefault()
          const previous = history.prev()
          if (previous !== undefined) setDraft(tabId, previous)
          return
        }
        case 'historyNext': {
          ev.preventDefault()
          const following = history.next()
          if (following !== undefined) setDraft(tabId, following)
          return
        }
        default:
          return
      }
    },
    [draft, history, markTyped, matches, menuActive, mention, onToggleFocus, passthrough, popupOpen, selected, send, setDraft, tabId]
  )

  const onPaste = useCallback(
    (ev: ClipboardEventBase<HTMLTextAreaElement>) => {
      const text = ev.clipboardData?.getData('text/plain') ?? ''
      if (text === '') return
      ev.preventDefault()

      if (passthrough) {
        // The CLI owns the line; hand it the text as a paste.
        for (const chunk of chunkForPty(text)) void window.qclod.write(tabId, chunk)
        setDraft(tabId, draft + text)
        return
      }

      const area = ev.currentTarget
      const start = area.selectionStart ?? draft.length
      const end = area.selectionEnd ?? draft.length
      setDraft(tabId, draft.slice(0, start) + text + draft.slice(end))
      requestAnimationFrame(() => {
        const caret = start + text.length
        area.setSelectionRange(caret, caret)
      })
    },
    [draft, passthrough, setDraft, tabId]
  )

  return (
    <div
      className={`composer${focused ? ' is-focused' : ''}${passthrough ? ' is-passthrough' : ''}`}
      data-testid="composer"
      onMouseDown={onRequestFocus}
    >
      {popupOpen && mention && (
        <MentionPopup
          items={matches}
          selected={selected}
          onPick={(path) => {
            const result = applyMention(draft, mention.start, caret, path)
            setDraft(tabId, result.text)
            setCaret(result.caret)
            areaRef.current?.focus()
            requestAnimationFrame(() => areaRef.current?.setSelectionRange(result.caret, result.caret))
          }}
        />
      )}
      {passthrough && (
        <div className="composer-mode" data-testid="passthrough-indicator">
          команда уходит в агента — меню рисует он
        </div>
      )}
      <textarea
        ref={areaRef}
        className="composer-input"
        data-testid="composer-input"
        rows={1}
        spellCheck={false}
        placeholder="напиши тут…"
        value={draft}
        onChange={(e) => {
          setDraft(tabId, e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onRequestFocus}
      />
      <div className="composer-hint">
        <kbd>Enter</kbd> отправить · <kbd>Shift+Enter</kbd> перенос · <kbd>Ctrl+`</kbd> терминал
      </div>
    </div>
  )
}

function applyPassthroughEcho(
  ev: KeyboardEvent<HTMLTextAreaElement>,
  draft: string,
  commit: (next: string) => void
): void {
  if (ev.key === 'Enter') commit('')
  else if (ev.key === 'Backspace') commit(draft.slice(0, -1))
  else if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey) commit(draft + ev.key)
}
