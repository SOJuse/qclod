import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('версия SDK закреплена точно', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.319')
})
test('в установленном SDK есть enableRemoteControl — иначе Remote Control молча пропадёт', () => {
  const sdk = readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'utf8')
  expect(sdk).toContain('enableRemoteControl(')
  expect(sdk).toContain('subtype:"remote_control"')
  const installed = JSON.parse(readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'))
  expect(installed.version).toBe('0.3.319')
})
