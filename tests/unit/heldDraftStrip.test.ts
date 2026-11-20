import { describe, expect, test, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HeldDraftStrip } from '../../src/renderer/components/Composer'

describe('HeldDraftStrip', () => {
  test('говорит, что случилось, и предлагает вставить черновик', () => {
    const html = renderToStaticMarkup(createElement(HeldDraftStrip, { onInsert: () => undefined }))
    expect(html).toContain('Окно зависло на длинном тексте. Черновик сохранён — вставить его снова?')
    expect(html).toMatch(/<button[^>]*data-testid="composer-held-insert"[^>]*>Вставить<\/button>/)
  })

  test('«Вставить» зовёт onInsert', () => {
    const onInsert = vi.fn()
    const tree = HeldDraftStrip({ onInsert }) as ReactElement<{ children: ReactElement<{ onClick?: () => void }>[] }>
    const button = tree.props.children.find((child) => child.props.onClick)
    button!.props.onClick!()
    expect(onInsert).toHaveBeenCalledTimes(1)
  })
})
