// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TemplateManagerView } from '@renderer/components/templates/TemplateManager'
import { APP_ACTIONS } from '@renderer/app/shortcuts'
import { commandsProvider } from '@renderer/palette/commands'
import type { PaletteContext } from '@renderer/palette/types'
import type { PromptTemplate } from '@shared/types'

function tpl(id: string, title: string, origin: PromptTemplate['origin'] = 'manual'): PromptTemplate {
  return { id, title, body: `текст ${title}`, origin, createdAt: 1, updatedAt: 1 }
}

function render(templates: PromptTemplate[], initialBody?: string): string {
  return renderToStaticMarkup(
    createElement(TemplateManagerView, {
      templates,
      ...(initialBody === undefined ? {} : { initialBody }),
      onClose: vi.fn(),
      onHarvest: vi.fn()
    })
  )
}

describe('TemplateManager', () => {
  test('пусто: заголовок, поиск, кнопки и текст пустого состояния', () => {
    const html = render([])
    expect(html).toContain('data-testid="template-manager"')
    expect(html).toContain('>Шаблоны<')
    expect(html).toContain('placeholder="Найти шаблон"')
    expect(html).toContain('data-testid="tpl-new"')
    expect(html).toContain('Новый шаблон')
    expect(html).toContain('data-testid="tpl-harvest"')
    expect(html).toContain('Собрать мои шаблоны')
    expect(html).toContain('Шаблонов пока нет. Создайте свой или соберите из истории Claude Code.')
    expect(html).not.toContain('data-testid="tpl-save"')
  })

  test('с initialBody редактор открыт на новом шаблоне с этим текстом', () => {
    const html = render([tpl('a', 'Ревью')], 'мой черновик {{x}}')
    expect(html).toContain('Название')
    expect(html).toContain('Текст')
    expect(html).toContain('мой черновик {{x}}</textarea>')
    expect(html).toContain('{{…}} — место, которое нужно заполнить: после вставки оно будет выделено.')
    expect(html).toMatch(/data-testid="tpl-save"(?![^>]*disabled)/)
    // A new template has nothing to delete yet.
    expect(html).not.toContain('data-testid="tpl-delete"')
  })

  test('tpl-save неактивна при пустом тексте', () => {
    const html = render([], '   ')
    expect(html).toMatch(/<button[^>]*data-testid="tpl-save"[^>]*disabled=""/)
  })

  test('метка «из истории» у origin: harvest', () => {
    const html = render([tpl('a', 'Ручной'), tpl('b', 'Собранный', 'harvest')])
    expect(html.match(/из истории/g)).toHaveLength(1)
    const harvested = html.indexOf('Собранный')
    expect(html.indexOf('из истории')).toBeGreaterThan(harvested)
  })

  test('500 шаблонов — предел', () => {
    const many = Array.from({ length: 500 }, (_v, i) => tpl(`t${i}`, `Ш${i}`))
    const html = render(many)
    expect(html).toContain('Шаблонов уже 500 — удалите ненужные.')
    expect(html).toMatch(/<button[^>]*data-testid="tpl-new"[^>]*disabled=""/)
  })
})

describe('действия Ctrl+K для шаблонов', () => {
  test('три новых действия с подписями', () => {
    const label = (id: string): string | undefined => APP_ACTIONS.find((a) => a.id === id)?.label
    expect(label('templates')).toBe('Шаблоны')
    expect(label('saveDraftAsTemplate')).toBe('Сохранить черновик как шаблон')
    expect(label('harvestTemplates')).toBe('Собрать мои шаблоны')
  })

  test('«Сохранить черновик как шаблон» без черновика неактивно', () => {
    const runAction = vi.fn()
    const ctx = (hasDraft: boolean): PaletteContext =>
      ({ sidebar: [], activeTabId: 't', files: [], commands: [], hasDraft, run: { runAction } }) as unknown as PaletteContext
    const titles = (hasDraft: boolean): string[] => commandsProvider.items('черновик', ctx(hasDraft)).map((r) => r.title)
    expect(titles(false)).not.toContain('Сохранить черновик как шаблон')
    expect(titles(true)).toContain('Сохранить черновик как шаблон')
  })
})
