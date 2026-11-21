import { describe, expect, test } from 'vitest'
import { agentRef, relayInstruction, subagentRoute } from '../../src/main/agent/subagentRelay'

describe('subagentRelay', () => {
  test('relayInstruction — точная строка решения 5', () => {
    expect(relayInstruction('a1', 'проверь тесты')).toBe(
      'Передай агенту a1 через SendMessage (to: "a1") это сообщение от пользователя, дословно:\n\nпроверь тесты'
    )
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
