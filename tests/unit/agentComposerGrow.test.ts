// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AgentComposer, agentPlaceholder } from '../../src/renderer/components/agents/AgentComposer'
import { useAppStore } from '../../src/renderer/state/useAppStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let contentHeight = 0
const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')

beforeEach(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => contentHeight })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight
  if (realScrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', realScrollHeight)
  act(() => useAppStore.getState().setAgentDraft('t:a', ''))
})

const field = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer-input"]')!

describe('AgentComposer как поле чата', () => {
  test('поле помечено data-composer-input: карточки возвращают туда фокус', () => {
    act(() => root.render(createElement(AgentComposer, { tabId: 't', cardId: 'a', disabledReason: null, placeholder: agentPlaceholder('running') })))
    expect(field().hasAttribute('data-composer-input')).toBe(true)
  })

  test('растёт по высоте с текстом, до 260 px, как Composer', () => {
    act(() => root.render(createElement(AgentComposer, { tabId: 't', cardId: 'a', disabledReason: null, placeholder: agentPlaceholder('running') })))
    contentHeight = 120
    act(() => useAppStore.getState().setAgentDraft('t:a', 'строка\nстрока\nстрока\nстрока\nстрока'))
    expect(field().style.height).toBe('120px')
    contentHeight = 900
    act(() => useAppStore.getState().setAgentDraft('t:a', 'очень длинный текст '.repeat(100)))
    expect(field().style.height).toBe('260px')
  })
})
