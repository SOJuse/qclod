import { afterEach, describe, expect, test, vi } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeadStrip } from '../../src/renderer/components/Composer'
import { NoticeRow } from '../../src/renderer/components/RibbonItem'
import type { RibbonItem } from '../../src/shared/types'

type Props = { 'data-testid'?: string; children?: ReactNode; onClick?: () => void }

/** The element with this test id in a rendered tree, components expanded. */
function find(node: ReactNode, testId: string): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, testId)
      if (hit) return hit
    }
    return undefined
  }
  if (!isValidElement<Props>(node)) return undefined
  if (node.props['data-testid'] === testId) return node
  if (typeof node.type === 'function') {
    return find((node.type as (p: unknown) => ReactNode)(node.props), testId)
  }
  return find(node.props.children, testId)
}

function click(tree: ReactNode, testId: string): void {
  const button = find(tree, testId)
  expect(button, testId).toBeDefined()
  button!.props.onClick!()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('полоса мёртвой сессии', () => {
  test('с canRetry — «Повторить» главной кнопкой и «Начать заново» второй', () => {
    const onRetry = vi.fn()
    const onRestart = vi.fn()
    const tree = createElement(DeadStrip, { canRetry: true, onRetry, onRestart })
    const html = renderToStaticMarkup(tree)

    expect(html.indexOf('data-testid="composer-retry"')).toBeLessThan(
      html.indexOf('data-testid="composer-restart"')
    )
    expect(find(tree, 'composer-retry')!.props.children).toBe('Повторить')
    expect(find(tree, 'composer-restart')!.props.children).toBe('Начать заново')

    click(tree, 'composer-retry')
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRestart).not.toHaveBeenCalled()
    click(tree, 'composer-restart')
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  test('без canRetry — как раньше, одна кнопка «Запустить заново»', () => {
    const onRestart = vi.fn()
    const tree = createElement(DeadStrip, { canRetry: false, onRetry: vi.fn(), onRestart })

    expect(find(tree, 'composer-retry')).toBeUndefined()
    expect(find(tree, 'composer-restart')!.props.children).toBe('Запустить заново')
    click(tree, 'composer-restart')
    expect(onRestart).toHaveBeenCalledTimes(1)
  })
})

describe('строка-заметка в ленте', () => {
  const notice = (action?: 'login' | 'retry'): Extract<RibbonItem, { kind: 'notice' }> => ({
    kind: 'notice',
    id: 'n1',
    text: 'Claude Code не вошёл в аккаунт. Войдите и нажмите «Повторить».',
    tone: 'error',
    ...(action ? { action } : {})
  })

  test('заметка с action login даёт кнопку «Войти», она открывает тот же вход, что установка', () => {
    const openTerminal = vi.fn(async () => undefined)
    vi.stubGlobal('window', { qclod: { openTerminal } })
    const tree = createElement(NoticeRow, { item: notice('login') })

    expect(renderToStaticMarkup(tree)).toContain('не вошёл в аккаунт')
    expect(find(tree, 'notice-login')!.props.children).toBe('Войти')
    click(tree, 'notice-login')
    expect(openTerminal).toHaveBeenCalledTimes(1)
  })

  test('обычная заметка без кнопки', () => {
    const tree = createElement(NoticeRow, { item: notice() })
    expect(find(tree, 'notice-login')).toBeUndefined()
    expect(renderToStaticMarkup(tree)).not.toContain('<button')
  })
})
