import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { formatSizeRu, modelCardView } from '../../src/renderer/components/settings/voiceSectionView'
import { VoiceSection } from '../../src/renderer/components/settings/VoiceSection'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import { resetVoice, useVoice } from '../../src/renderer/voice/voiceStore'
import { DEFAULT_SETTINGS } from '../../src/main/store/settingsStore'
import { DEFAULT_REPLACEMENTS } from '../../src/shared/voiceReplacements'
import { VOICE_MODEL_INFO, type VoiceModelsSnapshot, type VoiceModelView } from '../../src/shared/voice'

const view = (patch: Partial<VoiceModelView> = {}): VoiceModelView => ({
  id: 'gigaam-v3',
  state: { kind: 'absent' },
  available: true,
  ...patch
})

describe('modelCardView', () => {
  test('absent → download, «Не скачана»', () => {
    expect(modelCardView(view(), 'parakeet-v3')).toEqual({ status: 'Не скачана', actions: ['download'], selected: false })
  })

  test('downloading → cancel, «Скачиваю: 45% (104 МБ из 232 МБ)»', () => {
    const v = modelCardView(view({ state: { kind: 'downloading', done: 104e6, total: 232e6 } }), 'gigaam-v3')
    expect(v.status).toBe('Скачиваю: 45% (104 МБ из 232 МБ)')
    expect(v.actions).toEqual(['cancel'])
  })

  test('проверка и распаковка — свои слова, без кнопок', () => {
    expect(modelCardView(view({ state: { kind: 'verifying' } }), 'gigaam-v3')).toMatchObject({ status: 'Проверяю файлы…', actions: [] })
    expect(modelCardView(view({ state: { kind: 'extracting' } }), 'gigaam-v3')).toMatchObject({ status: 'Распаковываю…', actions: [] })
  })

  test('ready и не выбрана → use, delete; выбрана → selected, delete', () => {
    expect(modelCardView(view({ state: { kind: 'ready' } }), 'parakeet-v3')).toEqual({
      status: 'Готова',
      actions: ['use', 'delete'],
      selected: false
    })
    expect(modelCardView(view({ state: { kind: 'ready' } }), 'gigaam-v3')).toEqual({
      status: 'Готова',
      actions: ['delete'],
      selected: true
    })
  })

  test('error → retry, текст ошибки', () => {
    const v = modelCardView(view({ state: { kind: 'error', message: 'Нет связи с сервером.' } }), 'gigaam-v3')
    expect(v).toEqual({ status: 'Нет связи с сервером.', actions: ['retry'], selected: false })
  })

  test('Whisper available: false → disabledReason из снимка', () => {
    const v = modelCardView(
      view({ id: 'whisper-turbo-cuda', available: false, unavailableReason: 'Нужна видеокарта NVIDIA' }),
      'gigaam-v3'
    )
    expect(v).toEqual({ status: 'Не скачана', actions: ['download'], selected: false, disabledReason: 'Нужна видеокарта NVIDIA' })
  })
})

describe('formatSizeRu', () => {
  test('«232 МБ», «1,3 ГБ»', () => {
    expect(formatSizeRu(1_259_000_000)).toBe('1,3 ГБ')
    expect(formatSizeRu(232e6)).toBe('232 МБ')
    expect(formatSizeRu(104e6)).toBe('104 МБ')
  })
})

const SNAPSHOT: VoiceModelsSnapshot = {
  models: [
    { id: 'gigaam-v3', state: { kind: 'ready' }, available: true },
    { id: 'parakeet-v3', state: { kind: 'absent' }, available: true },
    { id: 'whisper-turbo-cuda', state: { kind: 'absent' }, available: false, unavailableReason: 'Нужна видеокарта NVIDIA' }
  ],
  micAccess: 'granted'
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

describe('VoiceSection', () => {
  const initialApp = useAppStore.getState()
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    useAppStore.setState(initialApp, true)
    useAppStore.getState().setSettings(DEFAULT_SETTINGS)
    resetVoice()
    useVoice.setState({ models: SNAPSHOT })
  })
  afterEach(() => vi.unstubAllGlobals())

  const render = (): string => renderToStaticMarkup(createElement(VoiceSection))

  test('вступление и подсказка дословно', () => {
    const html = render()
    expect(html).toContain(
      'Голос только вставляет текст в поле — отправляете вы сами. Речь распознаётся на этом компьютере и никуда не уходит.'
    )
    expect(html).toContain(
      'Удерживайте Ctrl+Пробел и говорите — или нажмите Ctrl+Пробел (или кнопку микрофона) один раз, чтобы начать, и ещё раз, чтобы закончить.'
    )
    expect(html).toContain('Модель распознавания')
  })

  test('три карточки с заголовками и meta дословно', () => {
    const html = render()
    expect(html.match(/<li class="voice-model[^"]*" data-testid="voice-model-/g)).toHaveLength(3)
    for (const info of Object.values(VOICE_MODEL_INFO)) {
      expect(html).toContain(escape(info.title))
      expect(html).toContain(escape(info.meta))
    }
    // GigaAM is ready and chosen; Parakeet can be downloaded; Whisper cannot, and says why.
    expect(html).toContain('Используется')
    expect(html).toMatch(/data-testid="voice-model-whisper-turbo-cuda".*?<button[^>]*disabled=""[^>]*>Скачать<\/button>/s)
    expect(html).toContain('Нужна видеокарта NVIDIA')
  })

  test('словарь при null показывает стандартные пары', () => {
    const html = render()
    expect(html).toContain('Словарь замен')
    expect(html).toContain('Что модель пишет по-русски → как это должно выглядеть. Окончания учитываются: «Клода» станет «Claude».')
    expect(html).toContain('Слышится')
    expect(html).toContain('Пишется')
    expect(html).toContain('Вернуть стандартный словарь')
    expect(html.match(/data-testid="voice-replacement-row"/g)).toHaveLength(DEFAULT_REPLACEMENTS.length)
    expect(html).toContain('value="тайп скрипт"')
    expect(html).toContain('value="TypeScript"')
  })

  test('свой словарь — свои пары', () => {
    useAppStore.getState().setSettings({ ...DEFAULT_SETTINGS, voice: { model: 'gigaam-v3', replacements: [{ from: 'кубер', to: 'Kubernetes' }] } })
    const html = render()
    expect(html.match(/data-testid="voice-replacement-row"/g)).toHaveLength(1)
    expect(html).toContain('value="Kubernetes"')
  })

  test('micAccess: denied — текст и «Открыть параметры микрофона»', () => {
    expect(render()).not.toContain('Открыть параметры микрофона')
    useVoice.setState({ models: { ...SNAPSHOT, micAccess: 'denied' } })
    const html = render()
    expect(html).toContain('Открыть параметры микрофона')
    expect(html).toContain('Windows не даёт Qclod микрофон.')
  })
})

describe('реестр', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  test('на Windows раздел voice стоит после permissions (40) и перед about (90)', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    vi.resetModules()
    const { sortedSections } = await import('../../src/renderer/components/settings/registry')
    const ids = sortedSections().map((s) => s.id)
    const voice = sortedSections().find((s) => s.id === 'voice')
    expect(voice).toMatchObject({ title: 'Голос', order: 50 })
    expect(ids.indexOf('voice')).toBe(ids.indexOf('permissions') + 1)
    expect(ids.indexOf('voice')).toBeLessThan(ids.indexOf('about'))
  })

  test('на Mac раздела нет', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
    vi.resetModules()
    const { sortedSections } = await import('../../src/renderer/components/settings/registry')
    expect(sortedSections().some((s) => s.id === 'voice')).toBe(false)
  })
})
