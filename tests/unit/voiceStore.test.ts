import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TabState } from '../../src/shared/types'
import type { VoiceEvent, VoiceModelsSnapshot } from '../../src/shared/voice'

const mic = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  fail: null as null | { name: string },
  handlers: null as null | { onChunk(pcm: Float32Array): void; onEnded(): void }
}))
vi.mock('../../src/renderer/voice/micCapture', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/voice/micCapture')>()
  return {
    ...real,
    startMic: async (h: { onChunk(pcm: Float32Array): void; onEnded(): void }) => {
      mic.starts += 1
      if (mic.fail) throw mic.fail
      mic.handlers = h
      return { stop: () => void (mic.stops += 1) }
    }
  }
})

import { useAppStore } from '../../src/renderer/state/useAppStore'
import {
  blurVoice,
  controlsFor,
  hideVoice,
  pressVoice,
  releaseVoice,
  resetVoice,
  startVoiceSync,
  useVoice
} from '../../src/renderer/voice/voiceStore'

const READY: VoiceModelsSnapshot = {
  models: [{ id: 'gigaam-v3', state: { kind: 'ready' }, available: true }],
  micAccess: 'granted'
}
const ABSENT: VoiceModelsSnapshot = {
  models: [{ id: 'gigaam-v3', state: { kind: 'absent' }, available: true }],
  micAccess: 'granted'
}

let emit: (e: VoiceEvent) => void
let calls: Array<[string, ...unknown[]]>
let beginAnswer: () => { session: string } | { error: string }
let sessions = 0
const agentSend = vi.fn()
const startVoice = vi.fn(async () => {})
let stopSync: () => void

const tab = (id: string): TabState => ({ id, cwd: 'C:\\p', title: id, overrides: {}, status: 'idle', badge: false })
const initialApp = useAppStore.getState()
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function setModels(s: VoiceModelsSnapshot): void {
  useVoice.setState({ models: s })
}

beforeEach(async () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Qclod Electron' })
  calls = []
  sessions = 0
  mic.starts = 0
  mic.stops = 0
  mic.fail = null
  mic.handlers = null
  beginAnswer = () => ({ session: `s${++sessions}` })
  agentSend.mockClear()
  startVoice.mockClear()
  vi.stubGlobal('window', {
    qclod: {
      send: agentSend,
      startVoice,
      voice: {
        models: async () => READY,
        download: async (id: string) => void calls.push(['download', id]),
        begin: async (tabId: string) => {
          calls.push(['begin', tabId])
          return beginAnswer()
        },
        end: async (session: string) => void calls.push(['end', session]),
        audio: (session: string, pcm: Float32Array) => void calls.push(['audio', session, pcm.length]),
        onEvent: (cb: (e: VoiceEvent) => void) => {
          emit = cb
          return () => {}
        },
        onModelsChanged: () => () => {}
      }
    }
  })
  useAppStore.setState(initialApp, true)
  useAppStore.getState().setTabs([tab('A'), tab('B')])
  useAppStore.getState().setActiveTabId('A')
  resetVoice()
  stopSync = startVoiceSync()
  await flush()
})

afterEach(() => {
  stopSync()
  // G9: voice never sends anything to the agent.
  expect(agentSend).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

/** A short press on the button: start (or stop). */
async function click(tabId = 'A', at = 0): Promise<void> {
  pressVoice(tabId, 'button', at)
  releaseVoice(at + 50)
  await flush()
}

const named = (name: string) => calls.filter((c) => c[0] === name)

describe('voiceStore', () => {
  test('press → begin → микрофон → куски уходят с id сессии', async () => {
    await click()
    expect(named('begin')).toEqual([['begin', 'A']])
    expect(mic.starts).toBe(1)
    mic.handlers!.onChunk(new Float32Array(1600))
    mic.handlers!.onChunk(new Float32Array(1600))
    expect(named('audio')).toEqual([
      ['audio', 's1', 1600],
      ['audio', 's1', 1600]
    ])
    expect(controlsFor('A').state).toBe('listening')
    await click('A', 1000)
    expect(named('end')).toEqual([['end', 's1']])
    expect(mic.stops).toBe(1)
    expect(controlsFor('A').state).toBe('off')
  })

  test('partial — серый текст своей вкладки; final — в черновик по курсору, серый снят', async () => {
    useAppStore.getState().setDraft('A', 'Начало.')
    await click()
    emit({ session: 's1', kind: 'partial', phrase: 0, text: 'Попроси Claude' })
    expect(controlsFor('A').tentative).toBe('Попроси Claude')
    expect(controlsFor('B').tentative).toBe('')
    emit({ session: 's1', kind: 'final', phrase: 0, text: 'Попроси Claude проверить тесты.', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('Начало. Попроси Claude проверить тесты.')
    expect(controlsFor('A').tentative).toBe('')
    expect(controlsFor('A').caretAfterInsert).toEqual({ at: 39, rev: 1 })
    emit({ session: 's1', kind: 'final', phrase: 1, text: 'Потом git push.', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('Начало. Попроси Claude проверить тесты. Потом git push.')
    expect(controlsFor('A').caretAfterInsert?.rev).toBe(2)
  })

  test('final после смены активной вкладки уходит во вкладку сессии', async () => {
    await click()
    useAppStore.getState().setActiveTabId('B')
    emit({ session: 's1', kind: 'final', phrase: 0, text: 'Фраза.', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('Фраза.')
    expect(useAppStore.getState().draftByTab['B'] ?? '').toBe('')
    // And after the stop, the last phrase still goes there.
    await click('A', 1000)
    emit({ session: 's1', kind: 'final', phrase: 1, text: 'Ещё одна.', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('Фраза. Ещё одна.')
    emit({ session: 's1', kind: 'done' })
    emit({ session: 's1', kind: 'final', phrase: 2, text: 'Поздно.', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('Фраза. Ещё одна.')
  })

  test('напечатал во время записи: фраза встаёт на курсор, напечатанное цело', async () => {
    useAppStore.getState().setDraft('A', 'сделай и проверь')
    await click()
    // Typed «тесты » in the middle and left the caret after it.
    useAppStore.getState().setDraft('A', 'сделай тесты и проверь')
    controlsFor('A').caretMoved(12)
    emit({ session: 's1', kind: 'final', phrase: 0, text: 'Быстро', joinsPrevious: false })
    expect(useAppStore.getState().draftByTab['A']).toBe('сделай тесты быстро и проверь')
  })

  test('blur при удержании — стоп и микрофон освобождён', async () => {
    pressVoice('A', 'key', 0)
    await flush()
    expect(mic.starts).toBe(1)
    blurVoice()
    expect(mic.stops).toBe(1)
    expect(named('end')).toEqual([['end', 's1']])
    expect(controlsFor('A').state).toBe('off')
    // The keyup that comes late does nothing.
    releaseVoice(3000)
    expect(named('end')).toHaveLength(1)
  })

  test('blur в режиме кнопки запись не останавливает', async () => {
    await click()
    blurVoice()
    expect(mic.stops).toBe(0)
    expect(controlsFor('A').state).toBe('listening')
  })

  test('скрытие окна — стоп и в режиме кнопки', async () => {
    await click()
    hideVoice()
    expect(mic.stops).toBe(1)
    expect(named('end')).toEqual([['end', 's1']])
    expect(controlsFor('A').state).toBe('off')
  })

  test('ошибка микрофона mic-denied — unavailable с текстом и voice.end', async () => {
    mic.fail = { name: 'NotAllowedError' }
    await click()
    expect(named('end')).toEqual([['end', 's1']])
    const c = controlsFor('A')
    expect(c.state).toBe('unavailable')
    expect(c.title).toBe(
      'Windows не даёт Qclod микрофон. Включите доступ: Параметры → Конфиденциальность и защита → Микрофон.'
    )
    // A click opens the menu rather than trying again.
    await click('A', 1000)
    expect(named('begin')).toHaveLength(1)
    expect(controlsFor('A').menuOpen).toBe(true)
    expect(controlsFor('A').menu.map((i) => i.label)).toEqual([
      'Попробовать снова',
      'Диктовка Windows (Win+H)',
      'Настройки голоса'
    ])
    mic.fail = null
    controlsFor('A').menu[0]!.onSelect()
    await flush()
    expect(named('begin')).toHaveLength(2)
    expect(controlsFor('A').state).toBe('listening')
  })

  test('отказ begin (no-model, mic-denied из main) — unavailable', async () => {
    beginAnswer = () => ({ error: 'mic-denied' })
    await click()
    expect(mic.starts).toBe(0)
    expect(controlsFor('A').state).toBe('unavailable')
  })

  test('engine-crashed — unavailable; следующее нажатие — снова begin', async () => {
    await click()
    emit({ session: 's1', kind: 'error', code: 'engine-crashed' })
    expect(mic.stops).toBe(1)
    const c = controlsFor('A')
    expect(c.state).toBe('unavailable')
    expect(c.title).toBe('Голосовой движок упал. Нажмите микрофон, чтобы запустить его снова.')
    await click('A', 1000)
    expect(named('begin')).toEqual([
      ['begin', 'A'],
      ['begin', 'A']
    ])
    expect(controlsFor('A').state).toBe('listening')
  })

  test('loading, потом ready: «Загружаю модель голоса…», потом «Слушаю»', async () => {
    beginAnswer = () => {
      // main says «loading» before it answers begin.
      emit({ session: 's1', kind: 'loading' })
      return { session: 's1' }
    }
    await click()
    expect(controlsFor('A').state).toBe('loading')
    expect(controlsFor('A').title).toBe('Загружаю модель голоса…')
    emit({ session: 's1', kind: 'ready' })
    expect(controlsFor('A').state).toBe('listening')
    expect(controlsFor('A').title).toBe('Слушаю. Нажмите ещё раз, чтобы закончить')
  })

  test('gpu-fallback — сессия идёт, текст в title до конца сессии', async () => {
    await click()
    emit({ session: 's1', kind: 'error', code: 'gpu-fallback' })
    expect(controlsFor('A').state).toBe('listening')
    expect(controlsFor('A').title).toBe('Whisper не запустился на видеокарте. Пока распознаёт GigaAM.')
    await click('A', 1000)
    expect(controlsFor('A').title).toBe('Голосовой ввод — Ctrl+Пробел. Нажмите и говорите или удерживайте')
  })

  test('нет модели: клик — меню из трёх пунктов; Ctrl+Пробел — Win+H', async () => {
    setModels(ABSENT)
    const c = controlsFor('A')
    expect(c.state).toBe('download')
    expect(c.title).toBe('Голосовой ввод: нужна модель (232 МБ)')
    expect(c.menu.map((i) => i.label)).toEqual([
      'Скачать модель голоса (232 МБ)',
      'Диктовка Windows (Win+H)',
      'Настройки голоса'
    ])
    await click()
    expect(named('begin')).toEqual([])
    expect(controlsFor('A').menuOpen).toBe(true)
    controlsFor('A').menu[0]!.onSelect()
    expect(named('download')).toEqual([['download', 'gigaam-v3']])

    pressVoice('A', 'key', 5000)
    releaseVoice(5050)
    expect(startVoice).toHaveBeenCalledTimes(1)
    expect(named('begin')).toEqual([])
  })

  test('нет модели не на Windows: Ctrl+Пробел ничего не делает, Win+H в меню нет', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
    setModels(ABSENT)
    expect(controlsFor('A').menu.map((i) => i.label)).toEqual(['Скачать модель голоса (232 МБ)', 'Настройки голоса'])
    pressVoice('A', 'key', 0)
    releaseVoice(50)
    expect(startVoice).not.toHaveBeenCalled()
  })

  test('скачивание — прогресс в title и кольце', () => {
    setModels({ models: [{ id: 'gigaam-v3', state: { kind: 'downloading', done: 104e6, total: 232e6 } , available: true }], micAccess: 'granted' })
    const c = controlsFor('A')
    expect(c.state).toBe('download')
    expect(c.title).toBe('Скачиваю модель голоса: 45%')
    expect(c.progress).toBeCloseTo(104 / 232)
  })

  test('событие чужой сессии игнорируется', async () => {
    await click()
    emit({ session: 'other', kind: 'final', phrase: 0, text: 'Чужое.', joinsPrevious: false })
    emit({ session: 'other', kind: 'partial', phrase: 0, text: 'чужое' })
    emit({ session: 'other', kind: 'error', code: 'engine-crashed' })
    emit({ session: 'other', kind: 'done' })
    expect(useAppStore.getState().draftByTab['A'] ?? '').toBe('')
    expect(controlsFor('A').tentative).toBe('')
    expect(controlsFor('A').state).toBe('listening')
  })

  test('закрытие вкладки сессии — стоп', async () => {
    await click()
    useAppStore.getState().setTabs([tab('B')])
    expect(mic.stops).toBe(1)
    expect(named('end')).toEqual([['end', 's1']])
    expect(useVoice.getState().session).toBeNull()
  })

  test('controlsFor другой вкладки во время записи — off', async () => {
    await click()
    expect(controlsFor('A').state).toBe('listening')
    expect(controlsFor('B').state).toBe('off')
    // A press there moves the session: the first one stops.
    await click('B', 1000)
    expect(named('end')).toEqual([['end', 's1']])
    expect(controlsFor('A').state).toBe('off')
    expect(controlsFor('B').state).toBe('listening')
  })

  test('запись начата в поле сабагента — финал в agentDrafts, черновик чата не тронут', async () => {
    useAppStore.setState({
      layerByTab: { A: { kind: 'agents', agentId: 'card-1' } },
      ribbonByTab: { A: [{ kind: 'subagent', id: 'card-1' } as never] }
    })
    useAppStore.getState().setDraft('A', 'чат')
    useAppStore.getState().setAgentDraft('A:card-1', 'агенту:')
    await click()
    // The layer closes mid-session: the phrase still goes where the session began.
    useAppStore.getState().closeAgents('A')
    emit({ session: 's1', kind: 'final', phrase: 0, text: 'Проверь тесты.', joinsPrevious: false })
    expect(useAppStore.getState().agentDrafts['A:card-1']).toBe('агенту: проверь тесты.')
    expect(useAppStore.getState().draftByTab['A']).toBe('чат')
  })
})
