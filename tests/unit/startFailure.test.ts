import { describe, expect, test } from 'vitest'
import { classifyStartFailure } from '../../src/main/agent/startFailure'

describe('classifyStartFailure', () => {
  test.each([
    ['No conversation found with session ID: abc', 'missing-conversation'],
    ['Session 1f2e not found', 'missing-conversation'],
    ['Not logged in · Please run /login', 'not-logged-in'],
    ['Invalid API key · Fix external API key', 'not-logged-in'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error"}}', 'not-logged-in'],
    ['Unauthorized', 'not-logged-in'],
    ['spawn ENOENT', 'other'],
    ['Claude Code process exited with code 1', 'other']
  ])('%s → %s', (m, kind) => expect(classifyStartFailure(m)).toBe(kind))
})
