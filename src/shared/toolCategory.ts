// Tool categories (spec 5.3): drive the icon, the left rule and the label of an action card.
// An error is a card state, not a category.

export type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'agent' | 'mcp' | 'plan' | 'other'

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: 'Чтение',
  search: 'Поиск',
  edit: 'Правка',
  command: 'Команда',
  agent: 'Агент',
  mcp: 'MCP',
  plan: 'План',
  other: 'Инструмент'
}

const RULES: ReadonlyArray<readonly [RegExp, ToolCategory]> = [
  [/^mcp__/, 'mcp'],
  [/^(Read|Glob|LS|NotebookRead)$/, 'read'],
  [/^(Grep|WebSearch|WebFetch|ToolSearch)$/, 'search'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'edit'],
  [/^(Bash|PowerShell|Monitor|TaskStop|KillShell|BashOutput)$/, 'command'],
  [/^(Agent|Task)$/, 'agent'],
  [/^(TodoWrite|AskUserQuestion|ExitPlanMode|EnterPlanMode)$/, 'plan']
]

export function toolCategory(name: string): ToolCategory {
  return RULES.find(([re]) => re.test(name))?.[1] ?? 'other'
}

/** `mcp__srv__a__b` → `{ server: 'srv', tool: 'a__b' }`; null for a non-MCP name. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  return i > 0 && i < rest.length - 2 ? { server: rest.slice(0, i), tool: rest.slice(i + 2) } : null
}
