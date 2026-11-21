import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import type { AppSettings } from '../../../shared/types'
import {
  VOICE_MODEL_IDS,
  VOICE_MODEL_INFO,
  voiceErrorText,
  type VoiceModelId,
  type VoiceModelView,
  type VoiceReplacement,
  type VoiceSettings
} from '../../../shared/voice'
import { DEFAULT_REPLACEMENTS } from '../../../shared/voiceReplacements'
import { useAppStore } from '../../state/useAppStore'
import { voicePlatform } from '../../voice/platform'
import { refreshModels, useVoice } from '../../voice/voiceStore'
import { Group } from './parts'
import { DICTIONARY_HINT, modelCardView, type ModelCardAction } from './voiceSectionView'
import './VoiceSection.css'

const DEFAULT_VOICE: VoiceSettings = { model: 'gigaam-v3', replacements: null }
const CONFIRM_MS = 4000

const ACTION_LABEL: Record<ModelCardAction, string> = {
  download: 'Скачать',
  cancel: 'Отменить',
  retry: 'Повторить',
  use: 'Использовать',
  delete: 'Удалить'
}

/** The store as it is now, on the server render too. */
function usePiece<T>(subscribe: (cb: () => void) => () => void, pick: () => T): T {
  return useSyncExternalStore(subscribe, pick, pick)
}

/** Main keeps what it takes (sanitize.ts) and tells the window (settingsChanged); a refusal has nothing to add here. */
function saveVoice(voice: VoiceSettings): void {
  void window.qclod.setSettings({ voice } as Partial<AppSettings>).catch(() => undefined)
}

function ModelCard({
  view,
  voice,
  confirming,
  onConfirm
}: {
  view: VoiceModelView
  voice: VoiceSettings
  confirming: boolean
  onConfirm(id: VoiceModelId | null): void
}): JSX.Element {
  const info = VOICE_MODEL_INFO[view.id]
  const card = modelCardView(view, voice.model)
  const run = (action: ModelCardAction): void => {
    switch (action) {
      case 'download':
      case 'retry':
        // A failure is in the model's state, with its words.
        void window.qclod.voice.download(view.id).catch(() => undefined)
        return
      case 'cancel':
        void window.qclod.voice.cancelDownload(view.id).catch(() => undefined)
        return
      case 'use':
        saveVoice({ ...voice, model: view.id })
        return
      case 'delete':
        if (!confirming) {
          onConfirm(view.id)
          return
        }
        onConfirm(null)
        void window.qclod.voice.remove(view.id).catch(() => undefined)
        return
    }
  }
  return (
    <li className={`voice-model${card.selected ? ' is-selected' : ''}`} data-testid={`voice-model-${view.id}`}>
      <div className="voice-model-head">
        <span className="voice-model-title">{info.title}</span>
        {card.selected && (
          <span className="voice-model-used" data-testid="voice-model-used">
            Используется
          </span>
        )}
      </div>
      <p className="voice-model-blurb">{info.blurb}</p>
      <p className="voice-model-meta">{info.meta}</p>
      <div className="voice-model-foot">
        <span className="voice-model-status" data-testid="voice-model-status" role="status">
          {card.status}
        </span>
        <span className="voice-model-actions">
          {card.actions.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn btn-sm${action === 'download' || action === 'use' ? '' : ' btn-ghost'}`}
              data-testid={`voice-model-${action}`}
              disabled={card.disabledReason !== undefined && (action === 'download' || action === 'retry')}
              onClick={() => run(action)}
            >
              {action === 'delete' && confirming ? 'Точно удалить?' : ACTION_LABEL[action]}
            </button>
          ))}
        </span>
      </div>
      {card.disabledReason !== undefined && (
        <p className="settings-hint voice-model-reason" data-testid="voice-model-reason">
          {card.disabledReason}
        </p>
      )}
      {!view.available && view.fix === 'vc-redist' && (
        <div className="voice-model-fix">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="voice-model-vc-redist"
            onClick={() => void window.qclod.voice.openVcRedist().catch(() => undefined)}
          >
            Скачать Visual C++ Redistributable
          </button>
        </div>
      )}
    </li>
  )
}

interface Row extends VoiceReplacement {
  key: number
}

/** «Слышится» → «Пишется». Saved when a field is left or a row goes; empty rows are not sent. */
function Dictionary({ voice }: { voice: VoiceSettings }): JSX.Element {
  const next = useRef(0)
  const toRows = (list: readonly VoiceReplacement[]): Row[] => list.map((r) => ({ ...r, key: next.current++ }))
  const [rows, setRows] = useState<Row[]>(() => toRows(voice.replacements ?? DEFAULT_REPLACEMENTS))
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  const save = (list: Row[]): void => {
    const replacements = list
      .map(({ from, to }) => ({ from: from.trim(), to: to.trim() }))
      .filter((r) => r.from !== '' && r.to !== '')
    saveVoice({ ...voiceRef.current, replacements })
  }
  const change = (key: number, patch: Partial<VoiceReplacement>): void =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  return (
    <Group title="Словарь замен">
      <p className="settings-hint">{DICTIONARY_HINT}</p>
      <table className="voice-dictionary" data-testid="voice-dictionary">
        <thead>
          <tr>
            <th scope="col">Слышится</th>
            <th scope="col">Пишется</th>
            <th aria-label="Убрать" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid="voice-replacement-row">
              <td>
                <input
                  type="text"
                  className="field"
                  data-testid="voice-replacement-from"
                  aria-label="Слышится"
                  value={row.from}
                  onChange={(e) => change(row.key, { from: e.target.value })}
                  onBlur={() => save(rows)}
                />
              </td>
              <td>
                <input
                  type="text"
                  className="field"
                  data-testid="voice-replacement-to"
                  aria-label="Пишется"
                  value={row.to}
                  onChange={(e) => change(row.key, { to: e.target.value })}
                  onBlur={() => save(rows)}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="voice-replacement-remove"
                  aria-label="Убрать"
                  title="Убрать"
                  onClick={() => {
                    const left = rows.filter((r) => r.key !== row.key)
                    setRows(left)
                    save(left)
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="voice-dictionary-actions">
        <button
          type="button"
          className="btn btn-sm"
          data-testid="voice-replacement-add"
          onClick={() => setRows((all) => [...all, { from: '', to: '', key: next.current++ }])}
        >
          Добавить
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="voice-replacement-reset"
          onClick={() => {
            setRows(toRows(DEFAULT_REPLACEMENTS))
            saveVoice({ ...voiceRef.current, replacements: null })
          }}
        >
          Вернуть стандартный словарь
        </button>
      </div>
    </Group>
  )
}

/**
 * «Голос» (Windows only, G11): which model listens — to download, use and
 * delete — whether Windows lets us have the microphone, and the dictionary of
 * replacements. Everything goes through main: the models' store and the settings.
 */
export function VoiceSection(): JSX.Element {
  const snapshot = usePiece(useVoice.subscribe, () => useVoice.getState().models)
  const voice = usePiece(useAppStore.subscribe, () => useAppStore.getState().settings?.voice) ?? DEFAULT_VOICE
  const [confirming, setConfirming] = useState<VoiceModelId | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void refreshModels()
    return () => clearTimeout(timer.current)
  }, [])

  const confirm = (id: VoiceModelId | null): void => {
    clearTimeout(timer.current)
    setConfirming(id)
    if (id !== null) timer.current = setTimeout(() => setConfirming(null), CONFIRM_MS)
  }

  const views: VoiceModelView[] = VOICE_MODEL_IDS.map(
    (id) => snapshot?.models.find((m) => m.id === id) ?? { id, state: { kind: 'absent' }, available: true }
  )

  return (
    <div className="voice-section" data-testid="voice-section">
      <Group>
        <p className="voice-intro">
          Голос только вставляет текст в поле — отправляете вы сами. Речь распознаётся на этом компьютере и никуда не
          уходит.
        </p>
        <p className="settings-hint">
          Удерживайте Ctrl+Пробел и говорите — или нажмите Ctrl+Пробел (или кнопку микрофона) один раз, чтобы начать, и
          ещё раз, чтобы закончить.
        </p>
        {snapshot?.micAccess === 'denied' && (
          <div className="settings-warning voice-mic-denied" data-testid="voice-mic-denied" role="alert">
            <span>{voiceErrorText('mic-denied', voicePlatform())}</span>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="voice-open-mic-settings"
              onClick={() => void window.qclod.voice.openMicSettings().catch(() => undefined)}
            >
              Открыть параметры микрофона
            </button>
          </div>
        )}
      </Group>
      <Group title="Модель распознавания">
        <ul className="voice-models">
          {views.map((view) => (
            <ModelCard key={view.id} view={view} voice={voice} confirming={confirming === view.id} onConfirm={confirm} />
          ))}
        </ul>
      </Group>
      <Dictionary voice={voice} />
    </div>
  )
}
