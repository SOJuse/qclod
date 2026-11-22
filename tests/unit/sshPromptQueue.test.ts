// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useSshPrompts } from '../../src/renderer/components/servers/sshPromptQueue'
import type { SshPrompt } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let push: (p: SshPrompt) => void
let closed: (e: { promptId: string }) => void
let answer: ReturnType<typeof vi.fn>
let seen: { first: string | null; answer: ((a: { promptId: string; ok: false }) => void) | null }

const prompt = (promptId: string): SshPrompt => ({ promptId, hostId: 'h1', kind: 'password', text: 'me@box', canRemember: false, retry: false })

function Probe(): null {
  const [first, answerPrompt] = useSshPrompts()
  seen.first = first?.promptId ?? null
  seen.answer = answerPrompt
  return null
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  seen = { first: null, answer: null }
  answer = vi.fn(async () => undefined)
  ;(window as unknown as { qclod: unknown }).qclod = {
    onSshPrompt: (cb: typeof push) => ((push = cb), () => undefined),
    onSshPromptClosed: (cb: typeof closed) => ((closed = cb), () => undefined),
    answerSshPrompt: answer
  }
  act(() => root.render(createElement(Probe)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('очередь вопросов ssh (R4)', () => {
  test('снятый main вопрос уходит из очереди — показывается следующий, ответа не шлём', () => {
    act(() => push(prompt('a')))
    act(() => push(prompt('b')))
    expect(seen.first).toBe('a')
    act(() => closed({ promptId: 'a' }))
    expect(seen.first).toBe('b')
    act(() => closed({ promptId: 'b' }))
    expect(seen.first).toBeNull()
    expect(answer).not.toHaveBeenCalled()
  })

  test('снят не первый — первый остаётся; ответ человека уходит и убирает вопрос', () => {
    act(() => push(prompt('a')))
    act(() => push(prompt('b')))
    act(() => closed({ promptId: 'b' }))
    expect(seen.first).toBe('a')
    act(() => seen.answer!({ promptId: 'a', ok: false }))
    expect(answer).toHaveBeenCalledWith({ promptId: 'a', ok: false })
    expect(seen.first).toBeNull()
  })

  test('тот же вопрос дважды — один раз', () => {
    act(() => push(prompt('a')))
    act(() => push(prompt('a')))
    act(() => closed({ promptId: 'a' }))
    expect(seen.first).toBeNull()
  })
})
