import { expect, test } from 'vitest'
import { CATEGORY_LABEL, mcpParts, toolCategory } from '../../src/shared/toolCategory'

test.each([
  ['Read', 'read'], ['Glob', 'read'], ['LS', 'read'], ['NotebookRead', 'read'],
  ['Grep', 'search'], ['WebSearch', 'search'], ['WebFetch', 'search'], ['ToolSearch', 'search'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Bash', 'command'], ['PowerShell', 'command'], ['Monitor', 'command'], ['TaskStop', 'command'],
  ['KillShell', 'command'], ['BashOutput', 'command'],
  ['Agent', 'agent'], ['Task', 'agent'],
  ['mcp__github__create_issue', 'mcp'],
  ['TodoWrite', 'plan'], ['AskUserQuestion', 'plan'], ['ExitPlanMode', 'plan'], ['EnterPlanMode', 'plan'],
  ['Skill', 'other'], ['', 'other']
])('%s → %s', (name, category) => expect(toolCategory(name)).toBe(category))

test('mcpParts берёт сервер и всё после него', () => {
  expect(mcpParts('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
  expect(mcpParts('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
  expect(mcpParts('Read')).toBeNull()
})

test('у каждой категории есть русская подпись', () => {
  expect(CATEGORY_LABEL).toEqual({
    read: 'Чтение', search: 'Поиск', edit: 'Правка', command: 'Команда',
    agent: 'Агент', mcp: 'MCP', plan: 'План', other: 'Инструмент'
  })
})
