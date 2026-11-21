import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Composer } from '../../src/renderer/components/Composer'
import { AgentComposer } from '../../src/renderer/components/agents/AgentComposer'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import { resetVoice, useVoice, useVoiceControls } from '../../src/renderer/voice/voiceStore'
import type { VoiceControls } from '../../src/shared/voice'

type ComposerProps = Parameters<typeof Composer>[0]
const noop = (): void => {}

const composer = (patch: Partial<ComposerProps> = {}): string =>
  renderToStaticMarkup(
    createElement(Composer, {
      tabId: 'A',
      status: 'idle',
      draft: '',
      sentTexts: [],
      attachments: [],
      fileIndex: [],
      commands: [],
      recentCommands: [],
      models: [],
      model: null,
      effort: null,
      started: true,
      focusToken: 0,
      onDraftChange: noop,
      onAttachmentsChange: noop,
      onSubmit: noop,
      onInterrupt: noop,
      onSendCommand: noop,
      onCommandUsed: noop,
      onOpenHistory: noop,
      onSetModel: noop,
      onSetEffort: noop,
      onCycleMode: noop,
      onRestart: noop,
      onRetry: noop,
      onPickFiles: noop,
      onImagePrepared: noop,
      ...patch
    })
  )

const agentComposer = (voice: VoiceControls): string =>
  renderToStaticMarkup(
    createElement(AgentComposer, { tabId: 'A', cardId: 'c', disabledReason: null, placeholder: 'агенту', voice })
  )

const voice = (patch: Partial<VoiceControls> = {}): VoiceControls => ({
  state: 'off',
  title: 'голос',
  tentative: '',
  menu: [],
  press: noop,
  release: noop,
  caretMoved: noop,
  ...patch
})

/** The title useVoiceControls gives the pane's button, rendered as the app renders it. */
function titleOf(tabId = 'A'): string {
  let seen: VoiceControls | null = null
  const Probe = (): null => {
    seen = useVoiceControls(tabId)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return `${seen!.state}|${seen!.title}`
}

const initialApp = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
  useAppStore.setState(initialApp, true)
  resetVoice()
})
afterEach(() => vi.unstubAllGlobals())

const tentativeLine = /<div class="composer-voice-tentative" data-testid="composer-voice-tentative"[^>]*>([^<]*)<\/div>/

describe('useVoiceControls: title каждого состояния', () => {
  const ready = { models: [{ id: 'gigaam-v3' as const, state: { kind: 'ready' as const }, available: true }], micAccess: 'granted' as const }

  test('off', () => {
    useVoice.setState({ models: ready })
    expect(titleOf()).toBe('off|Голосовой ввод — Ctrl+Пробел. Нажмите и говорите или удерживайте')
  })

  test('listening и loading', () => {
    useVoice.setState({ models: ready, session: { id: 's', tabId: 'A', field: { tabId: 'A', agentKey: null }, phase: 'listening', note: null } })
    expect(titleOf()).toBe('listening|Слушаю. Нажмите ещё раз, чтобы закончить')
    useVoice.setState({ session: { id: 's', tabId: 'A', field: { tabId: 'A', agentKey: null }, phase: 'loading', note: null } })
    expect(titleOf()).toBe('loading|Загружаю модель голоса…')
  })

  test('download: нужна модель и скачивание', () => {
    useVoice.setState({ models: { models: [{ id: 'gigaam-v3', state: { kind: 'absent' }, available: true }], micAccess: 'granted' } })
    expect(titleOf()).toBe('download|Голосовой ввод: нужна модель (232 МБ)')
    useVoice.setState({
      models: {
        models: [{ id: 'gigaam-v3', state: { kind: 'downloading', done: 58e6, total: 232e6 }, available: true }],
        micAccess: 'granted'
      }
    })
    expect(titleOf()).toBe('download|Скачиваю модель голоса: 25%')
  })

  test('download выбранной в настройках модели', () => {
    useAppStore.setState({ settings: { voice: { model: 'parakeet-v3', replacements: null } } as never })
    useVoice.setState({
      models: {
        models: [
          { id: 'gigaam-v3', state: { kind: 'ready' }, available: true },
          { id: 'parakeet-v3', state: { kind: 'absent' }, available: true }
        ],
        micAccess: 'granted'
      }
    })
    expect(titleOf()).toBe('download|Голосовой ввод: нужна модель (670 МБ)')
  })

  test('unavailable — текст ошибки', () => {
    useVoice.setState({ models: ready, error: { tabId: 'A', code: 'ort-conflict' } })
    expect(titleOf()).toBe(
      'unavailable|Голосовой движок не запустился: мешает другая версия onnxruntime.dll в системе. Пока можно диктовать через Windows (Win+H).'
    )
    expect(titleOf('B')).toBe('off|Голосовой ввод — Ctrl+Пробел. Нажмите и говорите или удерживайте')
  })
})

describe('серая строка', () => {
  test('Composer: tentative, «Слушаю…» при listening, ничего при off', () => {
    expect(composer({ voice: voice({ state: 'listening', tentative: 'Попроси Claude' }) }).match(tentativeLine)?.[1]).toBe(
      'Попроси Claude'
    )
    expect(composer({ voice: voice({ state: 'listening' }) }).match(tentativeLine)?.[1]).toBe('Слушаю…')
    expect(composer({ voice: voice({ state: 'off' }) })).not.toContain('composer-voice-tentative')
  })

  test('AgentComposer: то же', () => {
    expect(agentComposer(voice({ state: 'listening', tentative: 'проверь тесты' })).match(tentativeLine)?.[1]).toBe(
      'проверь тесты'
    )
    expect(agentComposer(voice({ state: 'listening' })).match(tentativeLine)?.[1]).toBe('Слушаю…')
    expect(agentComposer(voice())).not.toContain('composer-voice-tentative')
  })

  test('серая строка — не в textarea', () => {
    const html = composer({ draft: 'набрано', voice: voice({ state: 'listening', tentative: 'говорю' }) })
    expect(html).toMatch(/<textarea[^>]*>набрано<\/textarea>/)
  })
})

describe('меню кнопки', () => {
  const items = [
    { id: 'download', label: 'Скачать модель голоса (232 МБ)', onSelect: noop },
    { id: 'windows', label: 'Диктовка Windows (Win+H)', onSelect: noop },
    { id: 'settings', label: 'Настройки голоса', onSelect: noop }
  ]

  test('открытое меню — подписи дословно, в Composer и AgentComposer', () => {
    for (const html of [
      composer({ voice: voice({ state: 'download', menu: items, menuOpen: true }) }),
      agentComposer(voice({ state: 'download', menu: items, menuOpen: true }))
    ]) {
      expect(html).toContain('data-testid="voice-menu"')
      const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
      expect(labels).toEqual(['Скачать модель голоса (232 МБ)', 'Диктовка Windows (Win+H)', 'Настройки голоса'])
    }
  })

  test('закрытое меню не рисуется', () => {
    expect(composer({ voice: voice({ state: 'download', menu: items }) })).not.toContain('voice-menu')
  })
})

test('без пропа voice кнопка как в этапе 2 (Win+H)', () => {
  const html = composer()
  expect(html).toContain('title="Голосовой ввод — диктовка Windows (Win+H). Говорите, текст появится в поле"')
  expect(html).not.toContain('data-state=')
  expect(html).not.toContain('composer-voice-tentative')
})
