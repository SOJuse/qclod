# Подставной Agent SDK

Стоит вместо `@anthropic-ai/claude-agent-sdk` во всех автотестах: набор
детерминирован, не требует аккаунта и не тратит токены.

**Формы сообщений не выдуманы.** Каждая снята с живой сессии и записана в
`docs/superpowers/notes/2026-11-07-sdk-probe-results.md`. Фикстура, которая
врёт о форме данных, хуже отсутствующей: тесты будут зелёными, а приложение
сломается на настоящем SDK.

Написано на `.mjs`, чтобы один и тот же файл годился и юнит-тестам, и
упакованному приложению под сквозными тестами, без сборки между ними. Типы
лежат рядом в `index.d.mts`.

## Как пользоваться

```ts
const driver = createFakeSdk({
  steps: [
    { kind: 'text', text: 'смотрю файл' },
    { kind: 'tool', name: 'Read', input: { file_path: 'auth.ts' }, result: '120 строк' }
  ]
})
for await (const message of driver.messages) { /* ... */ }
```

**Молчит до первого сообщения, как настоящий CLI 2.1.317.** Сценарий без
`steps` (или с `steps: []`) не выдаёт ничего — ни `system/init`, ни
`rate_limit_event`, ни `result`, — пока не придёт первый `send()`. На первом
`send` идут `system/init`, `rate_limit_event`, эхо сообщения, шаги `nextTurn`
и `result/success`. Сценарий с непустыми `steps` играет их сразу: это ход,
«уже отправленный» до старта, и `init` с `rate_limit_event` идут в его начале.
`init` и `rate_limit_event` приходят один раз за сессию; каждый ход
заканчивается `result/success`.

Модель, контекст и лимиты до первого сообщения можно узнать только
запросом: `getContextUsage()` (с полем `model`; `contextUsageDelayMs`
задерживает ответ) и `planLimits()` (окна из `script.planLimits`, `null` —
`null`; по умолчанию те же, что в `rate_limit_event`: 0.13 и 0.38).

## Шаги сценария

| Шаг | Что выдаёт |
|---|---|
| `text` | текст агента |
| `thinking` | блок размышлений; с `ms` — потоком, как в живой сессии (`message_start`, `thinking_delta`, пауза `ms`, `content_block_stop`, затем целое сообщение с тем же id), и лента показывает «Думал N с» |
| `tool` | вызов инструмента и его результат; `output` (объект) уходит как `tool_use_result` рядом с `tool_result` (формы — `sdk-tools.d.ts`); `pauseMs` — пауза между `tool_use` и результатом |
| `toolError` | вызов и результат с `is_error`; `output` уходит как `tool_use_result` |
| `askPermission` | спрашивает `canUseTool` с `toolUseID` будущего вызова и `signal`; разрешили — выполняет, отказали — `permission_denied` |
| `askPermissions` | несколько инструментов одного сообщения: спрашивает о всех сразу, у каждого свой `toolUseID`; разрешённые выполняет одним сообщением ассистента |
| `askQuestion` | вызов `AskUserQuestion`; `questions: [{question, header?, options, multiSelect?}]` — до четырёх вопросов, а `question`/`options` — сокращение для одного; `echoAnswers: true` — после ответа агент пишет текстом `Получено: …` (в ленте `tool_result` вопроса не виден); затем `canUseTool` с его id; ответ — `updatedInput.answers` в `tool_result`, отказ — `tool_result` с `is_error` |
| `todo` | вызов `TodoWrite` со списком задач |
| `subagent` | вызов `Agent`, вложенные шаги помечаются `parent_tool_use_id`; `tool_use_result` — `AgentOutput` (`status: completed`, `agentId`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `content`), итоги — из `stats` под теми же именами |
| `backgroundAgent` | вызов `Agent` с `run_in_background: true`; `tool_result` «Async agent launched successfully.» с `tool_use_result.status: async_launched`; `system/task_started`. **После `result` этого хода** — по `system/task_progress` на каждый элемент `progress`, затем (если `finish` не `null`) `system/task_notification` и сообщение пользователя с `origin.kind: task-notification` и текстом `<task-notification>…`. `pauseMs` — пауза между событиями; `agentId` по умолчанию — `a` и 16 hex. Порядок «после `result`» — решение C2 (тест видит, что ход кончился, а агент ещё работает); ответного хода главного агента на уведомление фейк не играет |
| `compact` | `compact_boundary` с токенами до и после |
| `crash` | бросает ошибку посреди потока |

## Что можно проверить после прогона

`driver.sent`, `driver.permissionRequests`, `driver.executedTools`,
`driver.questionAnswers` (что пришло в `updatedInput.answers` каждого
отвеченного вопроса), `driver.permissionMode`, `driver.interrupted`,
`driver.disposed` — чтобы
утверждать не только о том, что увидел интерфейс, но и о том, что дошло до
агента.

`interrupt()` абортит `signal` всех открытых вопросов `canUseTool`; такой
вопрос считается отказом и больше не держит ход.

## Транскрипты на диске: `../transcript.mjs`

Для тестов возобновления сессии из её JSONL-файла.

- `encodeProjectDir(cwd)` — имя папки проекта, как его строит SDK:
  всё, кроме латинских букв и цифр, заменено на `-`.
- `writeTranscript(configDir, cwd, sessionId, lines, subagents?)` — пишет
  `<configDir>/projects/<папка>/<sessionId>.jsonl` и для каждого подагента
  `<sessionId>/subagents/agent-<agentId>.jsonl` с `.meta.json`; возвращает
  путь основного файла.
- `resumedSession(sessionId, cwd)` — готовая сессия в форме сырого JSONL
  CLI 2.1.268–2.1.317: подагент Explore на переднем плане с итогами, сжатие
  (`compact_boundary` и сводка), фоновый «Прогон тестов» с уведомлением
  (`queued_command` и сообщение `task-notification`), упавшая «Сборка»,
  фоновый «Долгий обзор» без уведомления, ветка «старый вариант», отрезанная
  перемоткой, и служебные строки (`file-history-snapshot`, `cost-state`,
  `queue-operation`), которые читатель обязан пропускать.
