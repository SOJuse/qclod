import { mcpParts } from './toolCategory'

/**
 * What a call is, in the words a person uses. Covers the built-in tools of the
 * pinned SDK (sdk-tools.d.ts) and the older names a resumed session may carry;
 * an unknown tool keeps its own name, an MCP one shows server and tool.
 */
const TOOL_TITLE: Record<string, string> = {
  Read: 'Чтение',
  Edit: 'Правка',
  MultiEdit: 'Правки',
  Write: 'Запись',
  Bash: 'Команда',
  PowerShell: 'Команда PowerShell',
  BashOutput: 'Вывод команды',
  TaskOutput: 'Вывод задачи',
  KillShell: 'Остановка команды',
  TaskStop: 'Остановка задачи',
  Monitor: 'Наблюдение',
  Grep: 'Поиск',
  Glob: 'Поиск файлов',
  LS: 'Список файлов',
  ToolSearch: 'Поиск инструментов',
  WebFetch: 'Страница',
  WebSearch: 'Поиск в сети',
  NotebookRead: 'Чтение блокнота',
  NotebookEdit: 'Правка блокнота',
  Agent: 'Подагент',
  Task: 'Подагент',
  SendMessage: 'Сообщение агенту',
  TodoWrite: 'Список дел',
  AskUserQuestion: 'Вопрос',
  EnterPlanMode: 'Переход в план',
  ExitPlanMode: 'План готов',
  Skill: 'Навык',
  SlashCommand: 'Команда «/»',
  ListMcpResourcesTool: 'Ресурсы MCP',
  ReadMcpResourceTool: 'Ресурс MCP',
  ReadMcpResourceDir: 'Папка ресурсов MCP',
  RefreshMcpTools: 'Обновление MCP',
  ReportFindings: 'Находки',
  SendFeedback: 'Отзыв',
  ClaudeDesign: 'Дизайн',
  Projects: 'Проекты',
  TaskCreate: 'Новая задача',
  TaskGet: 'Задача',
  TaskUpdate: 'Обновление задачи',
  TaskList: 'Задачи',
  Workflow: 'Сценарий',
  CronCreate: 'Новое расписание',
  CronDelete: 'Удаление расписания',
  CronList: 'Расписания',
  ScheduleWakeup: 'Отложенный запуск',
  RemoteTrigger: 'Удалённый запуск',
  ShowOnboardingRolePicker: 'Выбор роли',
  OfferChromeSetup: 'Настройка Chrome',
  ReadNotifications: 'Уведомления',
  PushNotification: 'Уведомление',
  ProposeSkills: 'Навыки на выбор',
  ProposeGoal: 'Цель на выбор',
  Artifact: 'Артефакт',
  EnterWorktree: 'Вход в рабочую копию',
  ExitWorktree: 'Выход из рабочей копии'
}

export function toolTitle(name: string): string {
  const mcp = mcpParts(name)
  if (mcp) return `${mcp.server} · ${mcp.tool}`
  return Object.hasOwn(TOOL_TITLE, name) ? TOOL_TITLE[name] : name
}
