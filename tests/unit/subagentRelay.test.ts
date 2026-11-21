import { describe, expect, test } from 'vitest'
import { agentRef, relayInstruction, subagentRoute } from '../../src/main/agent/subagentRelay'
import { parseRelayInstruction } from '../../src/shared/relayText'

describe('subagentRelay', () => {
  test('relayInstruction — точная строка решения 5', () => {
    expect(relayInstruction('a1', 'проверь тесты')).toBe(
      'Передай агенту a1 через SendMessage (to: "a1") это сообщение от пользователя, дословно:\n\nпроверь тесты'
    )
  })

  test('parseRelayInstruction узнаёт ровно строку поручения', () => {
    expect(parseRelayInstruction(relayInstruction('a1', 'проверь\n\nтесты'))).toEqual({ ref: 'a1', text: 'проверь\n\nтесты' })
    expect(parseRelayInstruction(relayInstruction('my scout', 'x'))).toEqual({ ref: 'my scout', text: 'x' })
    // Not the exact template: an ordinary message.
    expect(
      parseRelayInstruction('Передай агенту a1 через SendMessage (to: "a2") это сообщение от пользователя, дословно:\n\nx')
    ).toBeNull()
    expect(parseRelayInstruction('Передай агенту a1 привет')).toBeNull()
    expect(parseRelayInstruction(`скажи: ${relayInstruction('a1', 'x')}`)).toBeNull()
    expect(parseRelayInstruction(relayInstruction('a1', ''))).toBeNull()
  })

  test('agentRef берёт agentId, затем taskId, затем label, иначе null', () => {
    expect(agentRef({ agentId: 'a1', taskId: 't1', label: 'scout' })).toBe('a1')
    expect(agentRef({ taskId: 't1', label: 'scout' })).toBe('t1')
    expect(agentRef({ label: 'scout' })).toBe('scout')
    expect(agentRef({})).toBeNull()
    expect(agentRef({ agentId: '', taskId: '' })).toBeNull()
  })

  test('subagentRoute: без SendMessage в init.tools — none, иначе и до init — main', () => {
    expect(subagentRoute({ tools: ['Read'] })).toBe('none')
    expect(subagentRoute({ tools: ['SendMessage'] })).toBe('main')
    expect(subagentRoute(null)).toBe('main')
    expect(subagentRoute({})).toBe('main')
  })
})
