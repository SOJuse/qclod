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

Поток всегда начинается с `system/init` и `rate_limit_event` и заканчивается
`result/success` — ровно как настоящий.

## Шаги сценария

| Шаг | Что выдаёт |
|---|---|
| `text` | текст агента |
| `thinking` | блок размышлений |
| `tool` | вызов инструмента и его результат |
| `toolError` | вызов и результат с `is_error` |
| `askPermission` | спрашивает `canUseTool`; разрешили — выполняет, отказали — `permission_denied` |
| `askQuestion` | вызов `AskUserQuestion` с вариантами |
| `todo` | вызов `TodoWrite` со списком задач |
| `subagent` | вызов `Task`, вложенные шаги помечаются `parent_tool_use_id` |
| `compact` | `compact_boundary` с токенами до и после |
| `crash` | бросает ошибку посреди потока |

## Что можно проверить после прогона

`driver.sent`, `driver.permissionRequests`, `driver.executedTools`,
`driver.permissionMode`, `driver.interrupted`, `driver.disposed` — чтобы
утверждать не только о том, что увидел интерфейс, но и о том, что дошло до
агента.
