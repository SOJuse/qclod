import './AgentsLayer.css'
import { useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import type { SubagentSendResult, SubagentState } from '../../../shared/types'
import type { VoiceControls } from '../../../shared/voice'
import { hintKeys } from '../../app/shortcuts'
import { useAppStore } from '../../state/useAppStore'
import { MicButton } from '../composer/MicButton'

type Refusal = Exclude<Extract<SubagentSendResult, { ok: false }>['reason'], 'empty'>

/** Why a message did not go, in the person's words. */
export const SEND_REFUSAL: Record<Refusal, string> = {
  'no-send-message': 'Этот Claude Code не умеет передавать сообщения сабагентам',
  'not-started': 'Агент ещё запускается — подождите секунду',
  'not-running': 'Главный агент не запущен',
  'unknown-agent': 'Агент больше не найден в этом чате'
}

/** A working agent is written to; a finished one is asked to go on. */
export function agentPlaceholder(state: SubagentState): string {
  return state === 'running'
    ? 'Написать агенту — передаст главный агент'
    : 'Продолжить работу агента — передаст главный агент'
}

interface Props {
  tabId: string
  /** The subagent's card in the ribbon: the only id the window sends (main finds the rest). */
  cardId: string
  disabledReason: string | null
  placeholder: string
  /** The same voice the chat's Composer gets (сверка F12); without it — Windows dictation. */
  voice?: VoiceControls
}

/**
 * The input of a subagent's own ribbon, where the chat's input stands while
 * it is open. There is no direct way to a subagent in Claude Code: the main
 * agent passes the message on, and the line under the field says so. The
 * draft is kept per agent in the store; a refusal keeps the text and says why.
 */
export function AgentComposer({ tabId, cardId, disabledReason, placeholder, voice }: Props): JSX.Element {
  const key = `${tabId}:${cardId}`
  const draft = useAppStore((s) => s.agentDrafts[key] ?? '')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const disabled = disabledReason !== null

  async function submit(): Promise<void> {
    const text = draft
    if (disabled || sending || text.trim() === '') return
    setSending(true)
    setRefusal(null)
    try {
      const result = await window.qclod.sendToSubagent(tabId, cardId, text)
      if (result.ok) {
        // Only what was sent goes: anything typed meanwhile stays.
        const now = useAppStore.getState().agentDrafts[key] ?? ''
        useAppStore.getState().setAgentDraft(key, now === text ? '' : now)
      } else if (result.reason !== 'empty') {
        setRefusal(SEND_REFUSAL[result.reason])
      }
    } catch {
      setRefusal(SEND_REFUSAL['not-running'])
    } finally {
      setSending(false)
    }
  }

  const reason = disabledReason ?? refusal
  return (
    <div className="composer agent-composer" data-testid="agent-composer">
      <div className="composer-row ring-host">
        <MicButton
          {...(voice ? { voice } : {})}
          disabled={disabled}
          onFallback={() => {
            // Windows types into whatever has the focus, so the field gets it first.
            field.current?.focus()
            void window.qclod.startVoice()
          }}
        />
        <textarea
          ref={field}
          className="composer-input ring-on-parent"
          data-testid="agent-composer-input"
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          value={draft}
          onChange={(ev) => {
            setRefusal(null)
            useAppStore.getState().setAgentDraft(key, ev.target.value)
          }}
          onKeyDown={(ev) => {
            if (ev.key !== 'Enter' || ev.shiftKey || ev.nativeEvent.isComposing) return
            ev.preventDefault()
            void submit()
          }}
        />
        <button
          type="button"
          className="composer-send"
          data-testid="agent-composer-send"
          aria-label="Отправить"
          title={hintKeys('Отправить', 'Enter')}
          disabled={disabled || sending}
          onClick={() => void submit()}
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="agent-composer-foot">
        <span className="agent-composer-via">через главного агента</span>
        {reason && (
          <span className="agent-composer-reason" data-testid="agent-composer-reason" role="status">
            {reason}
          </span>
        )}
      </div>
    </div>
  )
}
