// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HarvestSheetView, harvestErrorText, type HarvestState } from '@renderer/components/templates/HarvestSheet'
import { TemplateManagerView } from '@renderer/components/templates/TemplateManager'
import type { HarvestErrorReason, HarvestPreview, HarvestProject } from '@shared/types'

const project = (key: string, prompts: number): HarvestProject => ({ key, label: `C:\\${key}`, sessions: 1, prompts, chars: 100 })

function preview(extra: Partial<HarvestPreview> = {}): HarvestPreview {
  return {
    projects: [project('a', 1), project('b', 0), project('c', 0), project('d', 0), project('e', 0)],
    items: [{ projectKey: 'a', text: 'напиши тесты для модуля' }],
    prompts: 1,
    sessions: 3,
    chars: 12_400,
    sinceDays: 90,
    truncated: false,
    model: 'Sonnet',
    ...extra
  }
}

function render(state: HarvestState, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(HarvestSheetView, {
      state,
      projects: preview().projects,
      excluded: new Set<string>(),
      showItems: false,
      checked: new Set<number>(),
      onToggleProject: vi.fn(),
      onToggleShow: vi.fn(),
      onRun: vi.fn(),
      onStop: vi.fn(),
      onClose: vi.fn(),
      onToggleProposal: vi.fn(),
      onSave: vi.fn(),
      onRetry: vi.fn(),
      ...extra
    })
  )
}

describe('HarvestSheet', () => {
  test('загрузка', () => {
    const html = render({ step: 'loading' })
    expect(html).toContain('data-testid="harvest-sheet"')
    expect(html).toContain('Собрать мои шаблоны')
    expect(html).toContain('Смотрю историю Claude Code…')
  })

  test('сводка с числами и склонениями', () => {
    const html = render({ step: 'preview', preview: preview() })
    expect(html).toContain(
      'Qclod возьмёт ваши сообщения из истории Claude Code за последние 90 дней: 1 сообщение из 3 разговоров в 5 проектах, около 12 тыс. символов.'
    )
    expect(html).toContain('Возьмутся только сообщения, которые вы писали сами. Ответы Claude, вывод команд и содержимое файлов не читаются.')
    expect(html).toContain(
      'Они уйдут в Claude одним запросом через ваш Claude Code (модель Sonnet) и займут часть лимита подписки. Сами сообщения Qclod не сохраняет — только шаблоны, которые вы отметите.'
    )
    expect(html.match(/data-testid="harvest-project"/g)).toHaveLength(5)
    expect(html).toContain('C:\\a — 1 сообщ.')
    expect(html).toContain('Показать, что уйдёт')
    expect(html).not.toContain('Сообщений больше')
    expect(html).toMatch(/<button[^>]*data-testid="harvest-run"(?![^>]*disabled)/)

    const many = render({ step: 'preview', preview: preview({ prompts: 22, sessions: 21, chars: 900, truncated: true }) })
    expect(many).toContain('22 сообщения из 21 разговора в 5 проектах, около 0,9 тыс. символов.')
    expect(many).toContain('Сообщений больше — возьмутся самые свежие.')
  })

  test('что уйдёт — только чтение, моноширинно; пусто — нечего собирать', () => {
    const shown = render({ step: 'preview', preview: preview() }, { showItems: true })
    expect(shown).toContain('Скрыть')
    expect(shown).toContain('data-testid="harvest-items"')
    expect(shown).toContain('напиши тесты для модуля')

    const empty = render({ step: 'preview', preview: preview({ items: [], prompts: 0, sessions: 0, chars: 0, projects: [] }) })
    expect(empty).toContain('В истории нет ваших сообщений — собирать не из чего.')
    expect(empty).toMatch(/<button[^>]*data-testid="harvest-run"[^>]*disabled=""/)
  })

  test('снятая галочка проекта', () => {
    const html = render({ step: 'preview', preview: preview() }, { excluded: new Set(['b']) })
    const boxes = [...html.matchAll(/<input[^>]*data-testid="harvest-project"[^>]*>/g)].map((m) => m[0])
    expect(boxes.filter((b) => b.includes('checked=""'))).toHaveLength(4)
  })

  test('идёт запрос — «Остановить»', () => {
    const html = render({ step: 'running', preview: preview() })
    expect(html).toContain('Claude читает ваши сообщения и подбирает шаблоны… Обычно это меньше минуты.')
    expect(html).toContain('data-testid="harvest-stop"')
  })

  test('итог: карточки, «уже есть», сохранить неактивно без отмеченных, расход', () => {
    const state: HarvestState = {
      step: 'results',
      costUsd: 0.0123,
      proposals: [
        { title: 'Ревью', body: 'Сделай ревью {{ветки}}', why: 'просьбы о ревью', duplicate: false },
        { title: 'Тесты', body: 'Напиши тесты', why: '', duplicate: true }
      ]
    }
    const html = render(state)
    expect(html).toContain('Claude предлагает 2 шаблона. Отметьте нужные.')
    expect(html.match(/data-testid="harvest-proposal"/g)).toHaveLength(2)
    expect(html).toContain('уже есть')
    const boxes = [...html.matchAll(/<input[^>]*data-testid="harvest-pick"[^>]*>/g)].map((m) => m[0])
    expect(boxes).toHaveLength(2)
    expect(boxes.every((b) => !b.includes('checked=""'))).toBe(true)
    expect(boxes[1]).toContain('disabled=""')
    expect(boxes[0]).not.toContain('disabled=""')
    expect(html).toContain('просьбы о ревью')
    expect(html).toMatch(/<button[^>]*data-testid="harvest-save"[^>]*disabled=""[^>]*>Сохранить отмеченные \(0\)/)
    expect(html).toContain('Расход по оценке Claude Code: $0.0123 — в подписке это часть лимита.')

    const picked = render(state, { checked: new Set([0]) })
    expect(picked).toMatch(/<button[^>]*data-testid="harvest-save"(?![^>]*disabled)[^>]*>Сохранить отмеченные \(1\)/)

    const free = render({ ...state, costUsd: null })
    expect(free).not.toContain('Расход по оценке')
  })

  test('пустой ответ Claude', () => {
    const html = render({ step: 'results', proposals: [], costUsd: 0.001 })
    expect(html).toContain('Claude не нашёл повторяющихся просьб — шаблонов не предложено.')
  })

  test('каждая ошибка — свой текст и «Попробовать снова»', () => {
    const expected: Record<Exclude<HarvestErrorReason, 'cancelled'>, string> = {
      noAgent: 'Claude Code не найден. Укажите путь в настройках.',
      notLoggedIn: 'Claude Code не вошёл в аккаунт. Войдите и попробуйте снова.',
      limit: 'Лимит подписки исчерпан. Попробуйте после сброса.',
      timeout: 'Claude не ответил за 3 минуты.',
      badAnswer: 'Claude ответил не в том виде. Попробуйте ещё раз.',
      failed: 'Не получилось: сломалось'
    }
    for (const [reason, text] of Object.entries(expected)) {
      expect(harvestErrorText(reason as HarvestErrorReason, 'сломалось')).toBe(text)
      const html = render({ step: 'error', reason: reason as HarvestErrorReason, detail: 'сломалось' })
      expect(html).toContain(text)
      expect(html).toContain('Попробовать снова')
    }
  })

  test('менеджер после сохранения: «Сохранено: 3 шаблона.»', () => {
    const html = renderToStaticMarkup(
      createElement(TemplateManagerView, { templates: [], notice: 'Сохранено: 3 шаблона.', onClose: vi.fn(), onHarvest: vi.fn() })
    )
    expect(html).toContain('Сохранено: 3 шаблона.')
  })
})
