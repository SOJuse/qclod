import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { VoiceControls } from '../../src/shared/voice'
import { AgentComposer, SEND_REFUSAL, agentPlaceholder } from '../../src/renderer/components/agents/AgentComposer'

type Props = Parameters<typeof AgentComposer>[0]
const render = (patch: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(AgentComposer, {
      tabId: 't',
      cardId: 'a',
      disabledReason: null,
      placeholder: agentPlaceholder('running'),
      ...patch
    })
  )

describe('AgentComposer', () => {
  test('placeholder для работающего и законченного', () => {
    expect(agentPlaceholder('running')).toBe('Написать агенту — передаст главный агент')
    for (const state of ['done', 'failed', 'stopped', 'unfinished'] as const) {
      expect(agentPlaceholder(state)).toBe('Продолжить работу агента — передаст главный агент')
    }
    expect(render()).toContain('placeholder="Написать агенту — передаст главный агент"')
  })

  test('под полем — «через главного агента»', () => {
    expect(render()).toContain('через главного агента')
  })

  test('при disabledReason поле disabled и причина видна', () => {
    const html = render({ disabledReason: 'Главный агент не запущен' })
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
    expect(html).toContain('Главный агент не запущен')
    expect(render()).not.toMatch(/<textarea[^>]*disabled=""/)
  })

  test('с voice (state off) — composer-mic с title из voice.title', () => {
    const voice: VoiceControls = {
      state: 'off',
      title: 'Голосовой ввод — удерживайте',
      tentative: '',
      menu: [],
      press: () => undefined,
      release: () => undefined,
      caretMoved: () => undefined
    }
    const html = render({ voice })
    expect(html).toMatch(/data-testid="composer-mic"[^>]*title="Голосовой ввод — удерживайте"|title="Голосовой ввод — удерживайте"[^>]*data-testid="composer-mic"/)
  })

  test('без voice — микрофон как в Composer без пропа (диктовка Windows)', () => {
    expect(render()).toContain('data-testid="composer-mic"')
    expect(render()).toContain('диктовка Windows')
  })

  test('причины отказа — тексты из брифа', () => {
    expect(SEND_REFUSAL).toEqual({
      'no-send-message': 'Этот Claude Code не умеет передавать сообщения сабагентам',
      'not-started': 'Агент ещё запускается — подождите секунду',
      'not-running': 'Главный агент не запущен',
      'unknown-agent': 'Агент больше не найден в этом чате'
    })
  })
})
