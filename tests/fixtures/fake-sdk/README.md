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

Чтобы ходы отвечали по-разному, есть `turns: FakeStep[][]`: i-е отправленное
сообщение (с нуля, ход из `steps` не считается) играет `turns[i]`; когда
список кончился — `nextTurn`. Счёт общий для начавших ход и влитых в чужой
(см. «Очередь команд CLI»): влитое тоже берёт свой `turns[i]`.

Модель, контекст и лимиты до первого сообщения можно узнать только
запросом: `getContextUsage()` (с полем `model`; `contextUsageDelayMs`
задерживает ответ) и `planLimits()` (окна из `script.planLimits`, `null` —
`null`; по умолчанию те же, что в `rate_limit_event`: 0.13 и 0.38).

Процент контекста — `contextPercent` (по умолчанию 21). Чтобы он менялся
между ходами, есть `contextPercentByTurn: number[]`: до первого хода
`getContextUsage()` отвечает `contextPercent`, после i-го хода (по его
`result`) — i-м числом списка; когда список кончился, держится последнее.
`totalTokens` считается от процента при `maxTokens` 200 000. Счётчик ходов
растёт перед `result`, так что запрос контекста сразу после `result` уже
видит новый процент.

## Шаги сценария

| Шаг | Что выдаёт |
|---|---|
| `text` | текст агента |
| `thinking` | блок размышлений; с `ms` — потоком, как в живой сессии (`message_start`, `thinking_delta`, пауза `ms`, `content_block_stop`, затем целое сообщение с тем же id), и лента показывает «Думал N с» |
| `tool` | вызов инструмента и его результат; `output` (объект) уходит как `tool_use_result` рядом с `tool_result` (формы — `sdk-tools.d.ts`); `pauseMs` — пауза между `tool_use` и результатом |
| `toolError` | вызов и результат с `is_error`; `output` уходит как `tool_use_result` |
| `askPermission` | спрашивает `canUseTool` с `toolUseID` будущего вызова и `signal`; разрешили — выполняет, отказали — `permission_denied`; `echo: true` — после ответа агент пишет `Получено: <JSON>` с `message` отказа |
| `askPermissions` | несколько инструментов одного сообщения: спрашивает о всех сразу, у каждого свой `toolUseID`; разрешённые выполняет одним сообщением ассистента |
| `askQuestion` | вызов `AskUserQuestion`; `questions: [{question, header?, options, multiSelect?}]` — до четырёх вопросов, а `question`/`options` — сокращение для одного; `echoAnswers: true` — после ответа агент пишет текстом `Получено: …` (в ленте `tool_result` вопроса не виден); затем `canUseTool` с его id; ответ — `updatedInput.answers` в `tool_result`, отказ — `tool_result` с `is_error`; `echo: true` — после ответа агент пишет `Получено: <JSON>` с `message`, `answers` и `annotations` |
| `plan` | вызов `ExitPlanMode` с `plan` (сначала в потоке, как у CLI), затем `canUseTool` с его id; одобрили — `tool_result` с планом из `updatedInput.plan` (правка пользователя, проба 05b) или с исходным, отказали — `tool_result` с `is_error` и `message`; `echo: true` — `Получено: <JSON>` с `message` и `plan` |
| `todo` | вызов `TodoWrite` со списком задач |
| `subagent` | вызов `Agent`, вложенные шаги помечаются `parent_tool_use_id`; `tool_use_result` — `AgentOutput` (`status: completed`, `agentId`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `content`), итоги — из `stats` под теми же именами; `report` — текст отчёта (`content[].text` и текст `tool_result`, по умолчанию «подагент закончил»); `subagent` внутри `steps` — вложенный: его шаги помечены его собственным id |
| `backgroundAgent` | вызов `Agent` с `run_in_background: true`; `tool_result` «Async agent launched successfully.» с `tool_use_result.status: async_launched`; `system/task_started`. **После `result` этого хода** — по `system/task_progress` на каждый элемент `progress`, затем (если `finish` не `null`) `system/task_notification` и сообщение пользователя с `origin.kind: task-notification` и текстом `<task-notification>…`. `pauseMs` — пауза между событиями; `agentId` по умолчанию — `a` и 16 hex. Порядок «после `result`» — решение C2 (тест видит, что ход кончился, а агент ещё работает); ответного хода главного агента на уведомление фейк не играет |
| `backgroundBash` | вызов `Bash` с `run_in_background: true`; `tool_result` «Command running in background with ID: <id>» и `tool_use_result {stdout:'', stderr:'', interrupted:false, backgroundTaskId}`; `system/task_started {task_id, tool_use_id, description, task_type:'local_bash', is_backgrounded:true}`; `system/background_tasks_changed` со всеми работающими. **После `result` хода** — по куску из `chunks` каждые `pauseMs` (их копит `taskOutput`), затем, если `finish` не `null`, `task_notification {status, output_file, summary}` и `background_tasks_changed` без этой задачи. `taskId` по умолчанию — `b` и 8 hex, `description` — сама команда. **Формы взяты из `sdk.d.ts` и `sdk-tools.d.ts`, не с живой сессии** |
| `remoteAnswer` | как `askPermission` (тот же `toolUseID`, свой `signal`), но через `afterMs` (по умолчанию 50) абортит именно этот сигнал — так CLI шлёт `control_cancel_request`, когда ответили на телефоне; дальше по `decision`: `allow` — выполняет инструмент (результат `ok`), `deny` — `permission_denied`. Ответ Qclod после аборта игнорируется |
| `compact` | `compact_boundary` с токенами до и после |
| `crash` | бросает ошибку `message` посреди потока. `times: N` — шаг играют только первые N сессий, в следующих он пропускается. Сессия — это созданный драйвер: она засчитывается один раз, при создании, дошла она до шага или нет. Счётчик (по `message`) лежит в `fake-sdk-crashes.json` в папке `process.env.QCLOD_USER_DATA`, так что его видят все сессии одного прогона приложения; без этой переменной шаг падает всегда, как раньше. `times` читается в шагах верхнего уровня `steps` и `nextTurn`. `beforeInit: true` — падает до `system/init` и эха хода, как агент, который не вошёл в аккаунт: сессия так и не представилась, и отправленное в неё остаётся неотправленным |
| `limitHit` | лимит подписки: `rate_limit_event` со `status: 'rejected'` (`resetsAt` = сейчас + `resetsInMs`, `rateLimitType` = `type`, по умолчанию `five_hour`; `seven_day` — недельный), затем `assistant` с `error: 'rate_limit'` и текстом `You've hit your session limit · resets <время>`, а в конце хода `result` с `is_error: true` и тем же текстом в `result`. `times: N` — шаг срабатывает только первые N раз за сессию (считается по сессии, а не между сессиями, как у `crash`). Формы взяты из `sdk.d.ts` и `errors`-документации, не с живой сессии |
| `reportInput` | текст агента «картинок: N; типы: image/png; байт: M» по последнему `send`: сколько вложений-картинок пришло, их `mediaType` через запятую и сумма байт после декодирования base64 — чтобы e2e видел, что картинка дошла настоящим вложением |

## Очередь команд CLI

Работает для `send(input, { uuid, priority })` с `uuid`; `send` без `uuid` —
как раньше: свой ход, никаких кадров. Формы и порядок сняты с живого CLI 2.1.317
(`05a-queue-probe.md`).

| Что | Поведение фейка |
|---|---|
| кадр | `{type:'command_lifecycle', command_uuid, state, uuid, session_id}`: `command_uuid` — uuid сообщения, `uuid` — свежий id самого кадра |
| `queued` | сразу при `send`, мимо хода |
| `started` | у начавшего ход — до `system/init` (init приходит один раз за сессию, с первым ходом); у влитого — на границе шагов, после очередного шага сценария |
| влитое сообщение | идёт в текущий ход без `user`-эха, попадает в `driver.folded` и в `result.user_message_uuids` |
| ответ на влитое | сразу после его `started`, в том же ходе: шаги `turns[i]` этого сообщения (или `nextTurn`; нет их — ответа нет), со своими границами; потом доигрывают оставшиеся шаги хода. Как в живом CLI: модель читает сообщение после результатов инструментов и отвечает до `result`, отдельного хода нет |
| `completed` | влитого — **до** `result`; начавшего ход — **после** `result` |
| `result` | `user_message_uuids` (начавший ход первым), `queued_turn_count` — сколько ходов ещё ждёт |
| `priority: 'now'` при идущем ходе | упрощённо: ход обрывается на ближайшей границе, новое сообщение первым в очереди начинает следующий |
| `interrupt()` | ход кончается `result {subtype:'error_during_execution', is_error:true, terminal_reason:'aborted_tools'}`, затем `cancelled` начавшему его; очередь выполнится после. Ответ `{stillQueued: [uuid…], cancelled: []}` |
| `interrupt({cancelQueued:true})` | каждому из очереди — `cancelled`; ответ `{stillQueued: [], cancelled: [uuid…]}` |
| `cancelAsyncMessage(uuid)` / `cancelQueued(uuid)` | в очереди — `cancelled` и `true`; иначе `false` |
| `cancelQueuedOnInterrupt: false` | CLI с `interrupt_receipt_v1`, но без `interrupt_cancel_queued_v1` (в `capabilities` его нет): `interrupt()` не слышит `cancelQueued`, ответ `{stillQueued: [uuid…]}` **без поля `cancelled`**; очередь выполнится после прерывания, если её не снять по одному |
| `lifecycle: false` | `claude_code_version: '2.1.200'`, без `capabilities`, без кадров; `cancelQueued` и `cancelAsyncMessage` — `null`, `interrupt` — `undefined`; сообщения всё равно вливаются |
| `phoneCancel: {afterMs, uuid}` | кадр `cancelled` с чужим uuid через `afterMs` после первого `send` с uuid |

`system/init` несёт `claude_code_version: '2.1.317'` (своя версия — `init.claudeCodeVersion`) и `capabilities`
(`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`,
`msg_lifecycle_v1`). Влитые в оборванный ход сообщения закрываются как
обычно (`completed` до `result`) — для них живого CLI не снимали.

## Что можно проверить после прогона

`driver.sent`, `driver.permissionRequests`, `driver.permissionLog` (каждый ответ
`canUseTool`: `{name, behavior, message?, updatedInput?}`), `driver.executedTools`,
`driver.questionAnswers` (что пришло в `updatedInput.answers` каждого
отвеченного вопроса), `driver.permissionMode`, `driver.interrupted`,
`driver.disposed` — чтобы
утверждать не только о том, что увидел интерфейс, но и о том, что дошло до
агента.

`interrupt()` абортит `signal` всех открытых вопросов `canUseTool`; такой
вопрос считается отказом и больше не держит ход.

**Фоновые задачи.** Фейк — это драйвер (`AgentDriver`), а не `Query` SDK,
поэтому методы названы по драйверу (решение C12): `taskOutput(id)` вместо
`getTaskOutput` и `stopTask(id)`. `taskOutput` отдаёт
`{output, totalBytes, truncated}` — последние 8 КиБ того, что накопили куски
`backgroundBash`, полный размер в байтах и признак обрезки; для чужого id —
`null`; со скриптом `taskOutputUnavailable: true` — всегда `null` (CLI, который
не умеет читать вывод). Со скриптом `stopTaskError: '…'` `stopTask` бросает
ошибку с этим текстом, а задача работает дальше. `stopTask(id)` у работающей задачи сразу, вне очереди
хода, выдаёт `task_notification` со `status: 'stopped'` и
`background_tasks_changed` без неё; куски после этого не копятся, своего
уведомления задача больше не шлёт. Формы — из `sdk.d.ts`
(`SDKControlGetTaskOutputResponse`, `SDKTaskNotificationMessage`,
`SDKBackgroundTasksChangedMessage`), не с живой сессии.

**Remote Control.** Фейк отвечает тем же методам драйвера:
`remoteAvailability()` (`{available:true}` или, со `remoteControl.blocked`,
`{available:false, reason}`), `setRemoteControl(enabled, name?)` и, только в
фейке, `typeOnPhone(text, steps?)`. `remoteCalls` хранит вызовы:
`{enabled, name}` (имя — только если его дали) и `{enabled:false}` при
выключении. Поле сценария `remoteControl`: `blocked`, `enableError` (включение
отклоняется с этим текстом), `sessionUrl` (вместо
`https://claude.ai/code/session_fake0001`), `bridge` (по умолчанию
`[{state:'connected'}]`) и `phoneTurns`; паузы — `afterMs`. Включение отвечает
`{sessionUrl, connectUrl}` (`connectUrl` — `https://claude.ai/code?environment=env_fake`)
и затем само, вне хода, выдаёт
`{type:'system', subtype:'bridge_state', state, detail, failure_kind?, bridge_epoch:1, uuid, session_id}`
(`failure_kind` только при `failed`, по умолчанию `terminal`), а потом ходы с
телефона. Сообщения моста и ходы с телефона из очереди выдаются только между
ходами (настоящий CLI может вставлять их и посреди хода). Выключение отвечает `null` и выдаёт
`{type:'system', subtype:'worker_shutting_down', reason:'remote_control_disabled'}`.
Ход с телефона — `user`-сообщение той же формы, что эхо, шаги
(`steps ?? nextTurn`) и `result`; в `sent` он не попадает. Формы взяты из
раздела «Сверка с SDK и CLI» плана
`docs/superpowers/plans/2026-11-10-qclod-v3-stage5-remote.md`.

## Медленный и падающий IPC (не фейк, а шов в main)

Чтобы увидеть загрузку и ошибку экранов, обработчики `history:list`,
`agent:ribbon`, `settings:get`, `settings:set`, `hotkey:status`,
`permission:rules` и `setup:check` обёрнуты в `withFault`
(`src/main/testSeams/ipcFaults.ts`). Только в e2e-сборке:

- `QCLOD_FAKE_SLOW` — JSON `{ "канал": мс }`: обработчик сперва ждёт;
- `QCLOD_FAKE_FAIL` — JSON `{ "канал": "причина" }`: вызов отклоняется с `new Error(причина)`;
- `QCLOD_FAKE_FAIL_TIMES` — JSON `{ "канал": n }`: отказывать только первые n вызовов
  (без него — все), чтобы «Повторить» было видно в деле.

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

`getContextUsage()` отдаёт строки разбивки: `messages` и `system_prompt`
(`used`), `Autocompact buffer` (`buffer`), `Free space` (`free`) и
`MCP tools (deferred)` (`deferred`, панель его не рисует).
Строки следуют за процентом: `used` вместе равны `totalTokens` (делятся
30:12, как при 21 %), резерв — 9 000, пока есть место, `free` — остаток до
`maxTokens`. Легенда на снимке с 13 % сходится с числом в полосе.

## Разовый запрос (`fakeOneShot`, этап 7)

`fakeOneShot(script)` стоит вместо `query()` SDK в одноразовой форме
(«Собрать мои шаблоны»): `({ prompt, options })` отдаёт кадры одного ответа —
`system/init` без инструментов, `assistant` с текстом, `result/success` с
`result` и `total_cost_usd`, как у живого CLI 2.1.317 по пробе
`.superpowers/research/07-oneshot-probe.md`. Без `text` ответ — JSON-массив из
двух шаблонов. `delayMs` — пауза перед ответом, `abortController` из `options`
её прерывает (итератор бросает, как SDK). `fail`: `notLoggedIn` — «Not logged
in · Please run /login» с `error: 'authentication_failed'`, ошибочный `result`
и исключение; `limit` — `rate_limit_event` с `status: 'rejected'`, ответ с
`error: 'rate_limit'` и ошибочный `result`; `crash` — исключение. Свойство
`calls` хранит каждый `prompt` и `options`. В e2e-сборке сценарий берётся из
`QCLOD_FAKE_ONESHOT` (JSON).
