# Пробы Agent SDK — 2026-11-07

SDK `@anthropic-ai/claude-agent-sdk@0.3.319`, запуск против
`claude.exe` пользователя через `pathToClaudeCodeExecutable`.
Скрипт: `scripts/probe-sdk.mjs`. Стоимость проб — $0.18.

Всё ниже снято с живой сессии и с типов самого SDK, а не из документации.
Два пункта документации оказались неверны, и оба в нашу пользу.

## 1. `@путь` раскрывается — ПОДТВЕРЖДЕНО

Главное рискованное допущение, на котором держатся скрепка, вставка файлов и
`@`-упоминания.

- `@plain.txt` — агент ответил содержимым файла, **не вызвав ни одного
  инструмента**: SDK подставил содержимое прямо в запрос.
- `@"Мои файлы/файл 1.txt"` — то же самое. **Пробелы и кириллица работают, и
  соглашение о кавычках верное.** Это ровно то, что в v1 висело непроверенным
  и стояло первым пунктом релизного чек-листа.
- Контрольная проба без `@` — агент полез читать файл инструментом, то есть
  разница именно в `@`.

**Вывод:** прикрепление файлов делается подстановкой `@путь`, как и
задумано. Задача 10 не меняется.

## 2. Лимиты подписки ЕСТЬ — ДОКУМЕНТАЦИЯ ОШИБАЛАСЬ

Ранее было записано, что пятичасовой и недельный лимиты недостижимы вне
`statusLine`. Это неверно. Каждый ход приходит сообщение `rate_limit_event`:

```json
{ "status": "allowed", "rateLimitType": "five_hour", "resetsAt": 1794083400,
  "unifiedWindows": {
    "five_hour":  { "utilization": 0.13, "resetsAt": 1794083400 },
    "seven_day":  { "utilization": 0.38, "resetsAt": 1794481200 } } }
```

`utilization` — доля от 0 до 1, `resetsAt` — unix-время сброса. Есть и
состояние перерасхода (`overageStatus`, `isUsingOverage`).

**Вывод:** в панели будут оба лимита, с процентом и временем сброса — ровно
то, что пользователь просил. Раздел 6.5 спеки исправлен.

## 3. Компактизация — отдельное событие, а не догадка

`SDKCompactBoundaryMessage` (`type: 'system', subtype: 'compact_boundary'`)
несёт `trigger` (`manual` | `auto`), `pre_tokens`, `post_tokens`,
`duration_ms`.

**Вывод:** разделитель в ленте рисуется по настоящему событию и показывает,
сколько токенов освободилось. Выводить по падению счётчика не нужно.

## 4. Контекст — через `getContextUsage()`, не из результата хода

В сообщении `result` поля `context_usage` **нет** (проверено: `undefined`).
Данные контекста берутся вызовом `query.getContextUsage()`.

В `result` есть: `usage` (полная разбивка токенов, включая кэш),
`total_cost_usd`, `duration_ms`, `num_turns`, `modelUsage`,
`permission_denials`, `subagent_stats`.

## 5. Слэш-команды приходят сами, 130 штук

`system/init` содержит `slash_commands` — **130 записей** на этой машине,
включая пользовательские и плагинные. Отдельно есть `supportedCommands()` и
сообщение `SDKCommandsChangedMessage` для обновлений в середине сессии.

Форма `SlashCommand`: `name`, `description`, `argumentHint`, `aliases`,
`builtin`.

**Вывод:** палитра строится на настоящих данных и остаётся живой. Захардкода
нет нигде.

## 6. MCP-серверы со статусом приходят на старте

`system/init.mcp_servers`, реальный ответ на этой машине:

```json
[{"name":"plugin:context7:context7","status":"needs-auth"},
 {"name":"plugin:github:github","status":"pending"},
 {"name":"plugin:playwright:playwright","status":"pending"},
 {"name":"unity-mcp","status":"pending"},
 {"name":"blender","status":"pending"}]
```

Статус `needs-auth` в списке есть — значит в панели нужно не только
«подключён / упал», но и «требует входа». Живое состояние — через
`query.mcpServerStatus()`.

## 7. Что ещё есть в `system/init`

`model`, `permissionMode`, `cwd`, `session_id`, `tools`, `agents`, `skills`,
`plugins`, `memory_paths`, `claude_code_version`, `capabilities`,
`output_style`, `apiKeySource`, `fast_mode_state`.

Пришли также события `system/hook_started`, `hook_response`, `hook_progress`
и `system/thinking_tokens` — то есть хуки пользователя подхватываются сами,
как и ожидалось.

## 8. Методы сессии — все на месте

Проверено по типам: `interrupt()`, `setPermissionMode()`,
`supportedCommands()`, `mcpServerStatus()`, `getContextUsage()`,
`accountInfo()`. Плюс модульные: `listSessions`, `getSessionMessages`,
`getSessionInfo`, `forkSession`, `renameSession`, `deleteSession`,
`tagSession`.

Союз `SDKMessage` насчитывает более сорока видов сообщений — переводчик ленты
(задача 4) обязан игнорировать неизвестные, а не падать на них.
