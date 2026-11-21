import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { toolTitle } from '../../src/shared/toolTitle'
import { toolTarget } from '../../src/shared/ribbon'
import { cardOutcome, toolView, type ToolCardItem } from '../../src/shared/toolView'

const SDK_TOOLS = resolve(__dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts')

// The schema names a tool by its input type; these are called differently in a call.
const CALLED: Record<string, string> = {
  FileEdit: 'Edit',
  FileRead: 'Read',
  FileWrite: 'Write',
  ListMcpResources: 'ListMcpResourcesTool',
  ReadMcpResource: 'ReadMcpResourceTool'
}

/** Every built-in tool the pinned SDK describes, by the name a call carries. */
function sdkTools(): string[] {
  const src = readFileSync(SDK_TOOLS, 'utf8')
  const union = /export type ToolInputSchemas =([\s\S]*?);/.exec(src)?.[1] ?? ''
  return [...union.matchAll(/\|\s*(\w+)Input\b/g)]
    .map((m) => m[1])
    .filter((stem) => stem !== 'Mcp')
    .map((stem) => CALLED[stem] ?? stem)
}

test('список встроенных инструментов прочитан из SDK', () => {
  expect(sdkTools().length).toBeGreaterThan(30)
  expect(sdkTools()).toEqual(expect.arrayContaining(['Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite']))
})

test('у каждого встроенного инструмента SDK есть русское имя', () => {
  const raw = sdkTools().filter((name) => !/[а-яё]/i.test(toolTitle(name)))
  expect(raw).toEqual([])
})

test('и у тех, что SDK уже не описывает, но старые сессии их помнят', () => {
  for (const name of ['Task', 'Skill', 'NotebookRead', 'KillShell', 'BashOutput', 'MultiEdit', 'LS', 'SlashCommand', 'ToolSearch', 'PowerShell']) {
    expect(toolTitle(name), name).toMatch(/[а-яё]/i)
  }
})

test('неизвестный инструмент остаётся своим именем, MCP — сервер и инструмент', () => {
  expect(toolTitle('FrobnicateWidget')).toBe('FrobnicateWidget')
  expect(toolTitle('mcp__github__create_issue')).toBe('github · create_issue')
  expect(toolTitle('Read')).toBe('Чтение')
})

function generic(name: string, summary: string): ToolCardItem {
  return { kind: 'tool', id: 'i', toolUseId: 't', name, target: '', summary, detail: summary, state: 'done', input: {} }
}

test('голое «ok» в свёрнутой карточке читается как «готово»', () => {
  for (const word of ['ok', 'OK', 'Ok.', 'done', 'success']) {
    const item = generic('EnterPlanMode', word)
    expect(cardOutcome(item, toolView(item)), word).toBe('готово')
  }
})

test('содержательный итог инструмента остаётся как есть', () => {
  const item = generic('Skill', 'Launching skill: review')
  expect(cardOutcome(item, toolView(item))).toBe('Launching skill: review')
})

test('идущий вызов итога не показывает', () => {
  const item = { ...generic('Skill', 'ok'), state: 'running' as const }
  expect(cardOutcome(item, toolView(item))).toBe('')
})

test('голое «ok» в открытой карточке тоже читается как «готово»', () => {
  for (const word of ['ok', 'OK', 'Ok.', 'done', 'success']) {
    expect(toolView(generic('EnterPlanMode', word)), word).toEqual({ type: 'generic', text: 'готово' })
  }
  expect(toolView(generic('Skill', 'Launching skill: review'))).toEqual({
    type: 'generic',
    text: 'Launching skill: review'
  })
})

test('этап 4: SendMessage — «Сообщение агенту», цель — «→ адресат»', () => {
  expect(toolTitle('SendMessage')).toBe('Сообщение агенту')
  expect(toolTarget('SendMessage', { to: 'a1', message: 'привет' })).toBe('→ a1')
  expect(toolTarget('SendMessage', { message: 'без адреса' })).toBe('')
})
