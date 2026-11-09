# Qclod v3 — Этап 1: баги. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть баги B1–B14 из аудита и P1–P8 правой панели: ничего не виснет и не теряется, проверка типов чистая, юнит-тесты без unhandled rejection, тестовые лазейки есть только в сборке для e2e; вошёл в сессию (новую или восстановленную) — сразу видишь контекст, лимиты, модель и подагентов с честными статусами.

**Architecture:** Ядро v2 не меняется: SDK в главном процессе, `AgentSession` на вкладку, `PermissionBroker` между агентом и человеком. Чинится то, что лежит на стыках: какие поля SDK мы читаем (`toolUseID`, `signal`), как сессия считает ожидающие вопросы и отменяет их, как вкладка узнаёт о мёртвой сессии, какой файл запускается, в каком порядке события уходят в окно. Для панели — какие события подагентов мы слушаем, откуда берётся восстановленная лента (сам JSONL сессии, только чтение) и что панель спрашивает у процесса при старте, не дожидаясь первого ответа. Тестовые лазейки прячутся за флагом сборки `__QCLOD_TEST_SEAMS__`, который в релизной сборке равен `false` и вырезается бандлером.

**Tech Stack:** Electron 33, electron-vite 2, React 18, TypeScript 5, zustand 5, `@anthropic-ai/claude-agent-sdk` 0.3.319, Vitest 2, Playwright (`_electron`), electron-builder 25.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md` — раздел 4 «Этап 1 — баги» и решение раздела 7 о лазейках B14. Задачи 2a–2h (P1–P8) — по жалобе владельца «подагенты в правой панели не работают, в восстановленных сессиях ещё хуже» и разбору причин против настоящего CLI 2.1.317 / SDK 0.3.319; решения владельца по ним записаны в самих задачах.

## Global Constraints

- Платформа — только Windows 11 x64.
- Правило этапа: **каждый баг сначала воспроизводится падающим тестом, потом чинится.** Шаг «прогнать, убедиться что падает» не пропускается; если тест не падает на текущем коде — он ничего не ловит, его надо переписать.
- Для B1 фейковый SDK обязан передавать в `canUseTool` настоящие `toolUseID` и `signal` — иначе тест ничего не ловит (спека, раздел 4).
- Сквозные тесты гоняются только против подставного SDK (`tests/fixtures/fake-sdk`), никогда против настоящего агента.
- Qclod не трогает учётные данные и не пишет файлы настроек пользователя/проекта (спека, раздел 9).
- Qclod запускает собственный `claude` пользователя, не копию из SDK (`pathToClaudeCodeExecutable`).
- Тестовые лазейки (B14) работают только в сборке для e2e (флаг сборки), в релизной их нет (спека, раздел 7).
- Формы сообщений и опций SDK берутся из `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` / `sdk-tools.d.ts`, а не придумываются.
- Мелочи из `progress.md` (сырой текст ошибок, padTop, окно от фоновой вкладки, O(n·k) ленты) в этом этапе **не** чинятся — они уходят в этапы 2–3.
- В сообщениях коммитов **нет** подписей соавторов и любых упоминаний Claude/ИИ (запрет владельца). Если в шаге ниже такая строка встречается — не добавлять её. Сообщения короткие, по-человечески, в стиле существующей истории (`fix: …`, `feat: …`).
- Фейковый SDK ведёт себя как настоящий CLI: до первого сообщения не выдаёт ни `system/init`, ни `rate_limit_event`, ни `result` (Task 2a). Тест, который держался на обратном, не подгоняется под старое поведение.
- Файлы сессий CLI (`~/.claude/projects/**/*.jsonl` и файлы подагентов) Qclod **только читает** (Task 2d) и никогда в них не пишет.
- Порядок выполнения: Task 1, Task 2, Tasks 2a–2h, затем Task 3 и дальше. Номера задач 3–14 не менялись.
- Ветка — `feat/qclod-v2`. Команды проверки: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`.

## Сверка с кодом

Каждый баг перепроверен по коду ветки `feat/qclod-v2` (коммит `354bfe4`; P1–P8 — по коммиту `3324409`). Все настоящие; **отброшенных нет**. Уточнения к номерам строк аудита:

| # | Что видно в коде |
|---|---|
| B1 | `sdkDriver.ts:101` проверяет `'toolUseId' in opts`, а в `sdk.d.ts:295` поле называется `toolUseID` — условие всегда ложно. `signal` (`sdk.d.ts:230`) не передаётся вовсе. Запасные id: `AgentSession.ts:528` (`${tabId}:${Date.now()}`), `:554` (`plan-${Date.now()}` — аудит этот не упомянул), `:572` (`q-${Date.now()}`). Брокер хранит запросы в `Map` по этому id (`permissions.ts:56`) — два запроса в одну миллисекунду затирают друг друга, первый не отвечается никогда. `createDriver.ts:27` и помощник `makeSession` в `tests/unit/agentSession.test.ts:47` передают `{}`; фейковый `askPermission` передаёт `{ sessionId }`, а `askQuestion` вообще не зовёт `canUseTool` — поэтому двойная карточка вопроса тестами не ловилась. |
| B2 | `resolveExecutable.ts:37` ставит голое имя первым кандидатом. В `%APPDATA%\npm` лежат `claude` (sh-скрипт) и `claude.cmd`. `npm view @anthropic-ai/claude-code` (2.1.321): `bin: { claude: "bin/claude.exe" }` — npm сегодня ставит **нативный exe** внутрь пакета, а `claude.cmd` — лишь обёртка над ним. `findAgent.ts:114,124,128` добавляет кандидатов без расширения. SDK запускает `.js/.mjs/.ts` через `node`, всё прочее — напрямую (функция `l5e` в `sdk.mjs`). |
| B3 | `AgentSession.ts:333-337`: `interrupt()` ставит `idle`, но `pendingQuestions`, `pendingPlans` и запросы в брокере живут дальше; поздний ответ проходит `finally` на `:546` и ставит `busy` навсегда. |
| B4 | `TabController.ts:252`: `whenIdle()` резолвится сразу, потому что `start()` уже поставил `idle` (`AgentSession.ts:308`); настоящий CLI падает позже. Плюс `recoverFromDeadSession` (`:262`) удаляет `lastSessionId`, но не вызывает `persist()` — мёртвый id остаётся в `tabs.json` до первого ответа новой сессии. То же в `restart()` (`:177`). |
| B5 | `AgentSession.ts:531-546`: каждый запрос запоминает `previous` и в `finally` ставит `busy`, не глядя на второй ожидающий. |
| B6 | `install.ts:96` — `spawn(..., { shell: true })`, `:128` — `child.kill()` убивает только `cmd.exe`. `ipc.ts:57` перезаписывает `install`, не проверяя, идёт ли уже установка; `setupCancel` (`ipc.ts:61`) обнуляет его до того, как процесс умер. |
| B7 | `index.ts:156`: `defaultCwd: process.cwd() \|\| homedir()` — у установленного приложения `cwd` = папка установки или System32. |
| B8 | `sdkDriver.ts:192` — `session.return()` вместо `close()` (`sdk.d.ts:3373`, «terminate the underlying process»). `AgentSession.fail()` (`:608`) обнуляет `driver`, не закрывая его. `AgentSession.dispose()` (`:397`) ждёт `driver.dispose()` и `pump` без предела; `index.ts:237` ждёт `disposeAll()` без предела — выход может зависнуть. |
| B9 | `AgentSession.ts:327` собирает текст с `@`-упоминаниями (`composeText`) и передаёт драйверу вместе с теми же `attachments`; `sdkDriver.ts:28` добавляет упоминания второй раз. Фейк упоминаний не добавляет — поэтому тесты зелёные. |
| B10 | `npm run typecheck` → `src/shared/ribbon.ts(618,33): error TS2339: Property 'durationMs' does not exist on type 'Partial<…tool…> \| …'` — `patch` объявлен как `Partial<RibbonItem>` (`:607`). |
| B11 | `npm run test:unit` → «Unhandled Rejection: TypeError: driver.supportedModels is not a function» из `AgentSession.refreshModels` (`:381`), вызванного через `void` (`:318`). Те же `void` на `:316-317`, `:462`, `:485`. |
| B12 | `useAppStore.ts:106-122`: `setTabs` чистит только `busySinceByTab`; `ribbonByTab`, `todoByTab`, `panelByTab`, `draftByTab`, `attachmentsByTab`, `fileIndexByTab` закрытых вкладок остаются. |
| B13 | `index.ts:167` ленту батчит `RibbonBatcher` (16 мс), а `:168-171` панель и статус уходят сразу через `send` — «готов» обгоняет последний кусок текста. |
| B14 | `createDriver.ts:13`, `index.ts:135-136` (`QCLOD_FAKE_SDK`, `QCLOD_FAKE_HISTORY`), `agentIpc.ts:169,179` (`QCLOD_PICK_FOLDER`, `QCLOD_PICK_FILES`) читаются в любой сборке. `QCLOD_CONFIRM_BYPASS` (`index.ts:35`) уже закрыт `!app.isPackaged`. |
| P1 (фейк) | `tests/fixtures/fake-sdk/index.mjs:280-303`: `stream()` начинает с `system/init` и `rate_limit_event`, а при `steps: []` сразу же отдаёт `result` с `total_cost_usd: 0.0421` — до всякого сообщения. Фонового подагента фейк не умеет вовсе; шаг `subagent` отдаёт выдуманные `durationMs`/`toolUseCount`, и `ribbon.test.ts:427-429`, `formatting.spec.ts:91` проверяют ровно их. |
| P2 (A, C, D) | `ribbon.ts:606-624`: любой `tool_result` карточки подагента ставит `done`, в том числе «Async agent launched…» с `toolUseResult.status: 'async_launched'` (`sdk-tools.d.ts:155`). `subagentStats` (`:124-125`) ищет `durationMs`/`toolUseCount`, а настоящие поля — `totalDurationMs`/`totalToolUseCount` (`sdk-tools.d.ts:113-115`; `totalTokens` читается верно). Ошибка подагента (`:590-604`) превращает карточку в `toolError`, и `App.tsx:52` (`kind === 'subagent'`) выкидывает её из списка панели. |
| P3 (B, F) | `ribbon.ts:293-294` пропускает все `system`, кроме `compact_boundary`: `task_started`/`task_progress`/`task_notification`/`task_updated` (`sdk.d.ts:6430-6560`) не доходят. `INJECTED_TAGS` (`:143-151`) без `task-notification` — уведомление (`origin.kind: 'task-notification'`) становится пузырём пользователя. |
| P4 (E, F) | `TabController.ts:246` берёт историю из `getSessionMessages`: нет `toolUseResult`, нет ничего до последнего сжатия, нет шагов подагентов (`sdk.d.ts:941`, `includeSystemMessages` по умолчанию `false`). Сводка сжатия в JSONL — `user` с `isCompactSummary: true`; `ribbon.ts:546,561` смотрят только `isSynthetic` — сводка становится пузырём. `compact_boundary` в JSONL пишет `compactMetadata.preTokens`, а `onCompaction` (`:634`) читает `compact_metadata.pre_tokens`. |
| P5 (G, H) | `panelData.ts:46-61,101-146`: модель — только из `init`, лимиты — только из `rate_limit_event`, стоимость — только из `result`. При старте спрашиваются контекст, MCP и модели (`AgentSession.ts:316-318`), но не модель сессии (`getContextUsage().model`, `sdk.d.ts:4131`) и не лимиты (`usage_EXPERIMENTAL…`, `sdk.d.ts:3176`). Усилие вкладки нигде не хранится (`LaunchOverrides` без `effort`). После resume `total_cost_usd` считает только этот процесс; `cost-state` в JSONL тоже даёт `0`. |
| P6 (I, J) | `panelData.ts:106-111`: `init` пишет `mcp` состоянием на старте (`pending`) поверх живого ответа `mcpServerStatus()`. MCP обновляется только при открытии панели (`App.tsx:130`). IPC `agentPanel` (`agentIpc.ts:119-122`) ничего не возвращает, хотя `preload/index.ts:63` ждёт `PanelData`. |
| P7 (K) | `TabController.restore` (`:104`) поднимает только активную вкладку; лента фоновой (`itemsOf`, `:64`) и панель пусты до клика — «появится после запуска». |

Требование раздела 9 спеки («агент стартует у вкладки при первом переходе, запущенная вкладка работает в фоне») сверено: `TabController.restore` поднимает только активную (`:104`), `activate` — по переходу (`:153`), переключение сессий не останавливает. Код ведёт себя так, правка не нужна. Task 2g это сохраняет: фоновая вкладка показывает ленту и панель из записи, но процесс у неё по-прежнему стартует только при переходе.

## Review Focus

Случаи, которые спека подразумевает, но тесты отдельных багов сами бы не поймали (1–5 — для B-задач, 6–9 — для панели). Тест на каждый добавлен в задачу, которой принадлежит код.

1. **Путь npm с пробелом и кириллицей.** `C:\Users\Иван Петров\AppData\Roaming\npm\claude.cmd` — разворачивается в настоящий `claude.exe` и запускается. → Задача 5.
2. **Свой префикс npm.** `npm config set prefix D:\tools\npm`: обёртка лежит не в `%APPDATA%\npm`, а где-то в PATH — всё равно находится настоящий exe, а не `.cmd`. → Задача 5.
3. **Стоп в одной вкладке, пока вторая ждёт разрешения.** Ожидающий запрос соседней вкладки не отменяется и отвечается как обычно. → Задача 3.
4. **Клик по варианту вопроса уже после «Стоп».** Не возвращает «работает» навсегда: выбор уходит обычным сообщением, ход заканчивается `idle`. → Задача 3.
5. **«Отмена», затем сразу «Установить».** Вторая установка не стартует, пока первая не умерла целиком; после её смерти — стартует. → Задача 6.
6. **Длинный путь проекта.** SDK укорачивает имя папки в `~/.claude/projects` хешем — транскрипт всё равно находится (поиск по всем папкам). → Задача 2d.
7. **Перемотка в разговоре.** В JSONL остаётся отрезанная ветка — в восстановленной ленте её нет. → Задача 2d.
8. **Повторное уведомление того же подагента.** Агента продолжили через `SendMessage`, он уведомил второй раз — карточка берёт последний статус, а не застревает на первом. → Задача 2c.
9. **Уведомление внутри `system-reminder` настоящего сообщения пользователя.** Карточка закрывается, а то, что человек написал сам, остаётся пузырём. → Задача 2c.

---

### Task 1: B10 — проверка типов чистая

Первым, чтобы каждая следующая задача могла требовать зелёный `typecheck`.

**Files:**
- Modify: `src/shared/ribbon.ts:607`

**Interfaces:**
- Produces: зелёный `npm run typecheck` — предусловие всех задач ниже.

- [ ] **Step 1: Убедиться, что проверка типов падает**

Run: `npm run typecheck`
Expected: FAIL, `src/shared/ribbon.ts(618,33): error TS2339: Property 'durationMs' does not exist…`

Это и есть падающий тест бага: другого не нужно.

- [ ] **Step 2: Сузить тип патча**

`const patch: Partial<Extract<RibbonItem, { kind: 'subagent' }>> = { state: 'done', summary: clip(text, 160) }`. Поведение не меняется; `this.update(item.id, patch)` принимает его как `Partial<RibbonItem>`.

- [ ] **Step 3: Прогнать проверку типов и юнит-тесты**

Run: `npm run typecheck && npx vitest run tests/unit/ribbon.test.ts`
Expected: 0 ошибок типов, `ribbon.test.ts` PASS.

- [ ] **Step 4: Коммит**

```bash
git add src/shared/ribbon.ts
git commit -m "fix: type the subagent result patch so typecheck passes (B10)"
```

---

### Task 2: B1 — настоящие `toolUseID` и `signal` от SDK до карточки

Корень трёх симптомов: вопрос агента даёт две карточки и вешает сессию; параллельные разрешения затирают друг друга; `signal` теряется. Фейк сначала учится вести себя как настоящий SDK, потом чинится код.

**Решение по ответу на вопрос.** Сейчас выбор на карточке вопроса отклоняет `canUseTool` и отправляет выбор отдельным сообщением — потому что «типы SDK не говорят, как передаётся ответ». Теперь говорят: `AskUserQuestionInput.answers` в `sdk-tools.d.ts` («User answers collected by the permission component», вопрос → ответ). Ответ уходит как `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: choice } } }` в тот же `canUseTool`. Отдельное сообщение остаётся только запасным путём, когда ожидающего вопроса нет (повтор из истории, вопрос после «Стоп»).

**Порядок в фейке.** `askQuestion` выдаёт `tool_use`, затем спрашивает `canUseTool` — как настоящий CLI, иначе двойную карточку не воспроизвести. `askPermission` сохраняет нынешний порядок (спросить → выдать `tool_use` + результат), но передаёт тот же `toolUseID`, что у будущего `tool_use`. Причина: настоящий порядок «сначала карточка инструмента, потом разрешение» меняет вид ленты, а вид ленты — это этап 2 (раздел 5.3); здесь достаточно, чтобы id совпадали и карточки были связуемы.

**Files:**
- Create: `src/main/agent/permissionContext.ts`
- Modify: `src/main/agent/driver.ts`, `src/main/agent/sdkDriver.ts:99-108`, `src/main/agent/createDriver.ts:27`, `src/main/agent/AgentSession.ts:92,178-188,511-595`, `src/shared/ribbon.ts` (метод `hasToolUse`), `src/shared/types.ts` (`PermissionAnswer`)
- Modify: `tests/fixtures/fake-sdk/index.mjs`, `tests/fixtures/fake-sdk/index.d.mts`, `tests/fixtures/fake-sdk/README.md`
- Test: `tests/unit/fakeSdk.test.ts`, `tests/unit/sdkDriver.test.ts` (новый), `tests/unit/createDriver.test.ts` (новый), `tests/unit/agentSession.test.ts`, `tests/e2e/permissions.spec.ts:103-131`

**Interfaces:**
- Produces:
  - `interface ToolPermissionContext { toolUseId?: string; signal?: AbortSignal }` и `toPermissionContext(sdkOptions: unknown): ToolPermissionContext` в `permissionContext.ts` — читает `toolUseID` (строка, непустая) и `signal` (экземпляр `AbortSignal`), прочее игнорирует.
  - `DriverOptions.canUseTool(toolName, input, context: ToolPermissionContext): Promise<PermissionAnswer>`.
  - `PermissionAnswer` получает `updatedInput?: Record<string, unknown>`. `sanitizeAnswer` (IPC) его **не** пропускает — окно не может подменить ввод инструмента.
  - `RibbonBuilder.hasToolUse(toolUseId: string): boolean`.
  - Фейк: `canUseTool(name, input, { toolUseID: string; signal: AbortSignal })`; новый шаг `{ kind: 'askPermissions'; tools: Array<{ name: string; input?: object }> }` — одно сообщение ассистента, вопросы по всем инструментам **одновременно** (`Promise.all`), у каждого свой `toolUseID`; `interrupt()` абортит сигналы всех открытых вопросов; геттер `questionAnswers: Array<Record<string, string>>`.
  - `createSdkDriver` тестируется через `vi.mock('../../src/main/esm')`, подменяющий `importEsm` на `{ query: fakeQuery }`, где `fakeQuery` запоминает `{ prompt, options }` и отдаёт объект с `close`, `interrupt`, `return` и пустым `[Symbol.asyncIterator]`. Помощник `mockQuery()` в `tests/unit/sdkDriver.test.ts` переиспользуют задачи 8 и 9.

- [ ] **Step 1: Падающие тесты фейка**

```ts
// tests/unit/fakeSdk.test.ts
test('askPermission передаёт toolUseID будущего tool_use и AbortSignal', async () => {
  // canUseTool получает { toolUseID, signal }; toolUseID === id блока tool_use,
  // выданного после разрешения; signal instanceof AbortSignal
})
test('askQuestion сначала выдаёт tool_use, потом спрашивает canUseTool с его id', async () => {
  // порядок: assistant(tool_use AskUserQuestion, id X) → canUseTool(..., { toolUseID: X })
})
test('ответ на вопрос через updatedInput.answers попадает в tool_result', async () => {
  // canUseTool → { behavior:'allow', updatedInput:{ ...input, answers:{ 'Какой?':'Справа' } } }
  // tool_result содержит 'Справа'; driver.questionAnswers == [{ 'Какой?': 'Справа' }]
})
test('askPermissions спрашивает о всех инструментах сразу, у каждого свой id', async () => {
  // два вызова canUseTool до любого ответа; два разных toolUseID
})
test('interrupt абортит сигнал открытого вопроса', async () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/fakeSdk.test.ts`
Expected: FAIL — `toolUseID` undefined, `askPermissions` — «unknown step kind».

- [ ] **Step 3: Научить фейк**

Правки в `index.mjs`, `index.d.mts`, `README.md` (таблица шагов — строка `askPermissions`; раздел «что можно проверить» — `questionAnswers`). Запрет на `AskUserQuestion` фейк выдаёт как `tool_result` с `is_error: true`.

- [ ] **Step 4: Прогнать тесты фейка**

Run: `npx vitest run tests/unit/fakeSdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Падающие тесты стыка SDK → сессия**

```ts
// tests/unit/sdkDriver.test.ts
test('toolUseID и signal из SDK доходят до DriverOptions.canUseTool', async () => {
  // options.canUseTool('Bash', {}, { toolUseID: 'toolu_1', signal }) →
  // наш canUseTool получил { toolUseId: 'toolu_1', signal } (тот же объект сигнала)
})
test('allow с updatedInput уходит в SDK как updatedInput', async () => {})

// tests/unit/createDriver.test.ts  (process.env.QCLOD_FAKE_SDK = путь к фикстуре)
test('фикстура в e2e-режиме передаёт toolUseID и signal, а не {}', async () => {})

// tests/unit/agentSession.test.ts — помощник makeSession пробрасывает третий аргумент:
//   gate.ask = (name, input, opts) => options.canUseTool(name, input, toPermissionContext(opts))
describe('AgentSession: id запросов', () => {
  test('вопрос агента — одна карточка, и ответ на неё отпускает агента', async () => {
    // steps: [askQuestion 'Какой?' ['Справа','Снизу'], text 'понял']
    // после появления карточки: session.answerQuestion(card.toolUseId, 'Справа')
    // карточек question === 1; статус в итоге 'idle'; driver.questionAnswers == [{ 'Какой?': 'Справа' }]
    // driver.sent — пусто (ответ не продублирован сообщением); в ленте есть 'понял'
  })
  test('два разрешения в одном сообщении — два разных requestId, оба отвечаются', async () => {
    // steps: [askPermissions [Bash, Edit]]; askPermission копит запросы
    // requestId обоих различны и равны toolUseID; ответив обоим, driver.executedTools == ['Bash','Edit']
  })
  test('requestId разрешения — это toolUseID инструмента', async () => {})
})
```

- [ ] **Step 6: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/sdkDriver.test.ts tests/unit/createDriver.test.ts tests/unit/agentSession.test.ts`
Expected: FAIL — пустой `toolUseId`, две карточки вопроса, второй запрос не отвечается (тест висит до таймаута — это и есть баг).

- [ ] **Step 7: Починить**

- `sdkDriver.ts` и `createDriver.ts` зовут `options.canUseTool(name, input, toPermissionContext(opts))`; `sdkDriver` отвечает `updatedInput: answer.updatedInput ?? input`.
- `AgentSession`: id запроса — `opts.toolUseId ?? randomUUID()` во всех трёх местах (`Date.now()` уходит совсем). `pendingQuestions` хранит `{ input, resolve }`. `askQuestion` добавляет карточку, только если `!this.builder.hasToolUse(toolUseId)`. `answerQuestion` при ожидающем вопросе резолвит `allow` с `updatedInput.answers` (ключ — `questions[0].question`) и сообщения не шлёт; без ожидающего — шлёт выбор сообщением, как раньше.

- [ ] **Step 8: Обновить e2e вопроса**

`tests/e2e/permissions.spec.ts`, тест «вопрос агента…»: `steps: [askQuestion, { kind: 'text', text: 'понял, делаю справа' }]`, `nextTurn` убрать — ответ теперь продолжает тот же ход.

- [ ] **Step 9: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- permissions planmode`
Expected: PASS.

- [ ] **Step 10: Коммит**

```bash
git add src/main/agent src/shared tests
git commit -m "fix: read the SDK's toolUseID and signal, answer questions in place (B1)"
```

---

### Task 2a: P1 — фейк молчит до первого сообщения и умеет фоновых подагентов

Первым из панельных задач: все находки P2–P8 воспроизводятся только на фейке, который ведёт себя как настоящий CLI 2.1.317. Сейчас он выдаёт `system/init`, `rate_limit_event` и `result` ($0.0421) сразу при старте (`index.mjs:280-303`) — и тесты панели зелёные, хотя у человека панель пуста до первого ответа.

**Что значит «молчит».** Сценарий без `steps` (или с `steps: []`) не выдаёт **ничего**, пока не придёт первый `send()`; на первом `send` — `init`, `rate_limit_event`, эхо, `nextTurn`, `result`. Сценарий с непустыми `steps` по-прежнему играет их сразу — это ход, «уже отправленный» до старта; `init` и `rate_limit_event` идут в начале этого хода, как у настоящего CLI в начале первого хода. Так не приходится переписывать около сотни тестов со `steps`, а ложь «данные есть до первого сообщения» уходит (см. «Решения»).

**Files:**
- Modify: `tests/fixtures/fake-sdk/index.mjs`, `tests/fixtures/fake-sdk/index.d.mts`, `tests/fixtures/fake-sdk/README.md`
- Create: `tests/fixtures/transcript.mjs`, `tests/fixtures/transcript.d.mts`
- Test: `tests/unit/fakeSdk.test.ts`, `tests/unit/transcriptFixture.test.ts` (новый)

**Interfaces:**
- Consumes: фейковый `canUseTool(name, input, { toolUseID, signal })` (Task 2).
- Produces:
  - Новый шаг `{ kind: 'backgroundAgent'; name: string; agentType?: string; agentId?: string; pauseMs?: number; progress?: Array<{ tokens: number; toolUses: number; durationMs: number; lastTool?: string }>; finish?: { status: 'completed' | 'failed' | 'stopped'; summary: string; tokens: number; toolUses: number; durationMs: number } | null }`. Выдаёт по порядку: `assistant` с `tool_use` `Agent` (`input: { description: name, subagent_type, run_in_background: true }`); `user` с `tool_result` (текст начинается с `Async agent launched successfully.` и содержит `agentId: <id>`) и `tool_use_result: { isAsync: true, status: 'async_launched', agentId, description, outputFile }`; `system/task_started` (`task_id = agentId`, `tool_use_id`, `description`, `subagent_type`, `task_type: 'local_agent'`, `is_backgrounded: true`); по одному `system/task_progress` на элемент `progress` (`usage: { total_tokens, tool_uses, duration_ms }`, `last_tool_name`, `tool_use_id`); при `finish` — `system/task_notification` (`task_id`, `tool_use_id`, `status`, `summary`, `output_file`, `usage`), за ним `user` с `origin: { kind: 'task-notification' }` и строковым `content` вида `<task-notification>\n<task-id>…</task-id>\n<tool-use-id>…</tool-use-id>\n<output-file>…</output-file>\n<status>…</status>\n<summary>…</summary>\n<usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>\n</task-notification>`. `finish: null` — агент так и не заканчивает. Между событиями — `pauseMs`, если задан. `agentId` по умолчанию — `a` + 16 hex.
  - Шаг `subagent` отдаёт `tool_use_result` с настоящими полями `AgentOutput` (`sdk-tools.d.ts:96-150`): `{ status: 'completed', agentId, totalTokens, totalDurationMs, totalToolUseCount, content: [...] }`; в `stats` сценария — те же имена.
  - `getContextUsage()` возвращает ещё `model: state.model` (`sdk.d.ts:4131`); `script.contextUsageDelayMs?: number` задерживает ответ.
  - `planLimits(): Promise<{ fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null>` — из `script.planLimits` (`null` → `null`), по умолчанию те же окна, что в `rate_limit_event` (0.13 и 0.38). Метод драйвера появится в Task 2e; фейк получает его сразу.
  - `tests/fixtures/transcript.mjs`:
    - `encodeProjectDir(cwd: string): string` — `cwd.replace(/[^a-zA-Z0-9]/g, '-')`, как `sl()` в `sdk.mjs`.
    - `writeTranscript(configDir: string, cwd: string, sessionId: string, lines: object[], subagents?: Record<string, { meta: object; lines: object[] }>): string` — пишет `<configDir>/projects/<encodeProjectDir(cwd)>/<sessionId>.jsonl` и для каждого подагента `…/<sessionId>/subagents/agent-<agentId>.jsonl` + `.meta.json`; возвращает путь основного файла.
    - `resumedSession(sessionId: string, cwd: string): { lines: object[]; subagents: Record<string, { meta: object; lines: object[] }> }` — готовая сессия для P4–P8, строки в форме сырого JSONL (camelCase: `parentUuid`, `isSidechain`, `toolUseResult`, `compactMetadata`, `logicalParentUuid`, `isCompactSummary`, `origin`, `attachment`), снятой с живых файлов CLI 2.1.268–2.1.317. Цепочка по `parentUuid`:
      1. `user` «найди, где падает вставка» → `assistant` (`model: 'claude-opus-5'`) с текстом «смотрю».
      2. Подагент `Explore` «Обзор вставки» на переднем плане: `tool_use` `Agent` → `tool_result` + `toolUseResult` `{ status: 'completed', agentId: 'a1…', totalTokens: 18000, totalDurationMs: 42000, totalToolUseCount: 7 }`; файл подагента — два шага (`Read`, текст).
      3. `system/compact_boundary` (`parentUuid: null`, `logicalParentUuid` — предыдущая строка, `compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 20000 }`) → `user` с `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`, текст «This session is being continued from a previous conversation…».
      4. `user` «теперь проверь тесты» → фоновый подагент `general-purpose` «Прогон тестов»: `tool_result` «Async agent launched successfully…» + `toolUseResult` `{ isAsync: true, status: 'async_launched', agentId: 'a2…' }`; позже `attachment` `{ type: 'queued_command', prompt: '<task-notification>…<status>completed</status><summary>Agent "Прогон тестов" finished</summary><usage><subagent_tokens>93175</subagent_tokens><tool_uses>18</tool_uses><duration_ms>110172</duration_ms></usage>…' }` и `user` с `origin: { kind: 'task-notification' }` с тем же текстом.
      5. Подагент «Сборка» падает: `tool_result` `is_error: true`, текст «Agent type 'builder' not found».
      6. Фоновый подагент «Долгий обзор» (`a3…`) запущен, уведомления нет.
      7. `assistant` (`model: 'claude-opus-5'`, `usage: { input_tokens: 12, cache_creation_input_tokens: 1400, cache_read_input_tokens: 44022, output_tokens: 240 }`) с текстом «жду подагентов».
      8. Строка-ветка, отрезанная перемоткой: `user` «старый вариант» с `parentUuid` строки из п. 1, на которую никто не ссылается дальше. В ленте её быть не должно.
      Плюс по строке `file-history-snapshot`, `cost-state`, `queue-operation` (`enqueue`) с тем же уведомлением — читатель обязан их пропускать.

- [ ] **Step 1: Падающие тесты фейка**

```ts
// tests/unit/fakeSdk.test.ts
test('без steps фейк не выдаёт ничего, пока не пришло сообщение', async () => {
  // const driver = createFakeSdk({}); собираем поток 100 мс → []
  // driver.send({ text: 'привет', attachments: [] }) → kinds: ['system/init','rate_limit_event','user','result']
})
test('result до первого сообщения не приходит никогда', async () => {})
test('getContextUsage знает модель', async () => {
  // (await driver.getContextUsage()).model === 'claude-opus-5'
})
test('backgroundAgent: async_launched, потом task_started, progress и notification', async () => {
  // steps: [{ kind:'backgroundAgent', name:'Прогон тестов', progress:[{tokens:500,toolUses:2,durationMs:3000,lastTool:'Bash'}],
  //           finish:{ status:'completed', summary:'готово', tokens:900, toolUses:4, durationMs:9000 } }]
  // порядок: assistant(tool_use Agent X) → user(tool_result X, tool_use_result.status 'async_launched')
  //   → system/task_started(tool_use_id X) → system/task_progress(usage.total_tokens 500, last_tool_name 'Bash')
  //   → system/task_notification(status 'completed', usage.tool_uses 4) → user(origin.kind 'task-notification', '<tool-use-id>X</tool-use-id>')
})
test('backgroundAgent с finish: null не присылает уведомления', async () => {})
test('subagent отдаёт totalTokens/totalDurationMs/totalToolUseCount', async () => {})
// tests/unit/transcriptFixture.test.ts
test('writeTranscript кладёт файл туда, где его ищет CLI', () => {
  // path === join(dir,'projects','C--Users-u-proj', `${id}.jsonl`) для cwd 'C:\\Users\\u\\proj'
  // subagents/agent-<id>.jsonl и .meta.json рядом
})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/fakeSdk.test.ts tests/unit/transcriptFixture.test.ts`
Expected: FAIL — поток без `steps` начинается с `system/init`; `backgroundAgent` — «unknown step kind»; модуля `transcript.mjs` нет.

- [ ] **Step 3: Научить фейк и написать фикстуру транскрипта**

README: строка «Поток всегда начинается с `system/init`…» заменяется правилом «молчит до первого сообщения» выше; в таблицу шагов — `backgroundAgent`; раздел про `transcript.mjs`.

- [ ] **Step 4: Прогнать весь набор и пометить тесты, которые держались на лжи**

Run: `npm run test:unit && npm run test:e2e`
Тест, упавший только потому, что ждал `init`/`rate_limit_event`/`result` до первого сообщения (модель, лимиты, стоимость, MCP из `init`, `lastSessionId` после старта со `steps: []`), не переписывается под старое поведение: он помечается `test.fails` (vitest) / `test.fail()` (Playwright) с комментарием `// снять в Task 2e` (панель) или `// снять в Task 2f` (MCP). Тест, который ждал `init` ради вещи, которую ни одна задача 2b–2h не чинит, переписывается так, чтобы сначала отправить сообщение. Список помеченных — в описании коммита.
Expected: остальные PASS; помеченные «ожидаемо падают».

- [ ] **Step 5: Коммит**

```bash
git add tests
git commit -m "test: fake SDK stays silent until the first message, plays background agents (P1)"
```

---

### Task 2b: P2 — карточка подагента: фоновый не «готов» сразу, итоги читаются, упавший остаётся в списке

Находки A, C, D. Все три — в `RibbonBuilder.onToolResult` (`ribbon.ts:579-631`).

**Files:**
- Modify: `src/shared/types.ts` (карточка `subagent`), `src/shared/ribbon.ts:103-133,264-283,568-631`, `src/renderer/app/App.tsx:46-63`, `src/renderer/components/SidePanel.tsx:49-56,220-245`, `src/renderer/components/RibbonItem.tsx:127-150`
- Test: `tests/unit/ribbon.test.ts`, `tests/e2e/formatting.spec.ts:91-105`

**Interfaces:**
- Consumes: шаги фейка `subagent` (с настоящими итогами) и `backgroundAgent` (Task 2a).
- Produces:
  - `export type SubagentState = 'running' | 'done' | 'failed' | 'stopped' | 'unfinished'` в `types.ts`; у карточки `subagent` `state: SubagentState` (у `tool` остаётся `ToolState`) и новые необязательные поля `background?: boolean`, `agentId?: string`, `taskId?: string`, `lastTool?: string`.
  - `subagentStats` читает сначала `totalTokens`, `totalDurationMs`, `totalToolUseCount` (`sdk-tools.d.ts:113-115`), прежние написания остаются запасными.
  - `tool_use_result.status === 'async_launched'` (или `isAsync === true`): карточка остаётся `running`, получает `background: true` и `agentId`; `summary` не трогается (текст «Async agent launched…» не показывается).
  - `tool_result` с `is_error` у карточки `subagent`: карточка **остаётся** `kind: 'subagent'`, `state: 'failed'`, `summary: clip(error, 160)`; в `toolError` превращаются только обычные инструменты.
  - `closeOpen()` ставит работающему подагенту `state: 'unfinished'`, `summary: 'не закончил'`.
  - `AgentRun` (`SidePanel.tsx`) — `{ id; name; task; state: SubagentState; tokens?; durationMs?; toolCalls?; lastTool?; summary? }`; `App.tsx` кладёт все карточки `subagent`, включая упавшие. Подписи состояния в панели и в карточке ленты: `running` — «работает», `done` — «готов», `failed` — «ошибка», `stopped` — «остановлен», `unfinished` — «не закончил». У работающего панель показывает ещё `lastTool` и число инструментов, у закончившего — время и токены, у упавшего — `summary`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/ribbon.test.ts — сообщения берутся из прогона фейка (collect(createFakeSdk({ steps })))
test('фоновый подагент после async_launched всё ещё работает', () => {
  // steps: [backgroundAgent 'Прогон тестов', finish: null]
  // карточка: state 'running', background true, agentId задан, summary не содержит 'Async agent launched'
})
test('итоги подагента читаются из totalTokens/totalDurationMs/totalToolUseCount', () => {
  // subagent stats { totalTokens: 18000, totalDurationMs: 42000, totalToolUseCount: 7 }
  // → tokens 18000, durationMs 42000, toolCalls 7
})
test('упавший подагент остаётся подагентом со статусом failed', () => {
  // steps: [toolError name 'Agent', input { description:'Сборка', subagent_type:'builder' }, error 'Agent type…']
  // only(items,'subagent').length === 1, state 'failed', summary начинается с 'Agent type'; toolError нет
})
test('подагент, работавший при закрытии, — не закончил', () => {
  // backgroundAgent finish null; closeOpen() → state 'unfinished', summary 'не закончил'
})
```

Тесты `ribbon.test.ts:427-436,531-535` и e2e `formatting.spec.ts:91` переводятся на настоящие имена полей.

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/ribbon.test.ts`
Expected: FAIL — фоновая карточка `done`; `toolCalls` undefined; упавший стал `toolError`.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/ribbon.test.ts && npm run test:e2e -- formatting ribbon`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/shared src/renderer tests
git commit -m "fix: background agents stay running, real run totals, failed agents stay listed (P2)"
```

---

### Task 2c: P3 — живые события подагента: токены, инструменты, итог

Находки B и первая половина F. `apply()` пропускает всё `system`, кроме `compact_boundary` (`ribbon.ts:293-294`), а `<task-notification>` нет в `INJECTED_TAGS` (`ribbon.ts:143-151`) — уведомление о конце подагента становится пузырём пользователя.

**Files:**
- Modify: `src/shared/ribbon.ts:143-151,284-306,540-577`
- Test: `tests/unit/ribbon.test.ts`, `tests/unit/agentSession.test.ts`

**Interfaces:**
- Consumes: `SubagentState`, поля `background`/`agentId`/`taskId`/`lastTool` (Task 2b); шаг `backgroundAgent` (Task 2a).
- Produces:
  - `export interface TaskNotice { taskId: string; toolUseId: string; status: 'completed' | 'failed' | 'stopped' | 'killed'; summary: string; usage?: { tokens: number; toolCalls: number; durationMs: number } }` и `export function parseTaskNotifications(text: string): TaskNotice[]` в `ribbon.ts` — все блоки `<task-notification>…</task-notification>` в тексте; теги `<task-id>`, `<tool-use-id>`, `<status>`, `<summary>`, `<usage><subagent_tokens>/<tool_uses>/<duration_ms>`; блок без `<tool-use-id>` и `<task-id>` пропускается.
  - Статусы в карточку: `completed` → `done`, `failed` → `failed`, `stopped`/`killed` → `stopped`.
  - `RibbonBuilder.apply` для `system`: `task_started` — карта `task_id → карточка` по `tool_use_id`, `taskId`, `background = is_backgrounded`; `task_progress` — `tokens = usage.total_tokens`, `toolCalls = usage.tool_uses`, `durationMs = usage.duration_ms`, `lastTool = last_tool_name`, `summary` из `summary`, если есть; `task_updated` — по `task_id`, `patch.status` `completed`/`failed`/`killed` закрывает карточку (`failed` — `summary = patch.error`, если есть), прочие статусы не трогают; `task_notification` — по `tool_use_id`, иначе по `task_id`: статус, `summary`, итоги из `usage`, `lastTool` убирается; `background_tasks_changed` принимается и **ничего не меняет** — порядок относительно уведомлений не обещан (`sdk.d.ts:3843`), закрывает карточку только уведомление или `task_updated`. События задач без карточки (`local_bash`, монитор) игнорируются.
  - `onUser`: из строкового или текстового содержимого сначала извлекаются `parseTaskNotifications` и применяются к карточкам; `'task-notification'` добавляется в `INJECTED_TAGS`; сообщение с `origin.kind === 'task-notification'` пузыря не даёт никогда. Повторное уведомление того же `tool-use-id` (агент «может уведомить ещё раз») перезаписывает статус и итог.
  - `result` не закрывает фоновые карточки (как сейчас — только `closeOpenBlocks`); тест это фиксирует.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/ribbon.test.ts
test('task_progress обновляет токены, число инструментов и последний инструмент', () => {
  // backgroundAgent progress [{tokens:500,toolUses:2,durationMs:3000,lastTool:'Bash'}], finish null
  // карточка: running, tokens 500, toolCalls 2, lastTool 'Bash'
})
test('task_notification закрывает карточку с итогом', () => {
  // finish completed, summary 'готово', tokens 900 → state 'done', summary 'готово', tokens 900, toolCalls 4, lastTool undefined
})
test('уведомление failed и stopped дают свои статусы', () => {})
test('уведомление пользователем не показывается', () => {
  // ни одного item kind 'user' с текстом, содержащим 'task-notification' или 'Прогон тестов'
})
test('уведомление только сообщением пользователя тоже закрывает карточку', () => {
  // убрать из потока system/task_notification, оставить user с origin task-notification → state 'done', tokens 93175 из <usage>
})
test('result посреди работы фонового агента не закрывает его', () => {})
test('background_tasks_changed без агента в списке не меняет состояние', () => {})
test('parseTaskNotifications читает блок внутри system-reminder', () => {})
test('повторное уведомление того же агента перезаписывает статус', () => {
  // Review Focus 8: completed, затем failed с тем же tool-use-id → state 'failed'
})
test('уведомление в system-reminder закрывает карточку, а текст человека остаётся', () => {
  // Review Focus 9: user content 'посмотри ещё
<system-reminder><task-notification>…</task-notification></system-reminder>'
  // карточка done; пузырь user с текстом 'посмотри ещё'
})
// tests/unit/agentSession.test.ts
test('ход кончается idle, а фоновый подагент в ленте всё ещё работает, пока не придёт уведомление', async () => {
  // steps: [backgroundAgent pauseMs 30, finish completed]; сначала 'idle' и карточка running → затем done
})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/ribbon.test.ts tests/unit/agentSession.test.ts`
Expected: FAIL — `tokens` undefined, карточка не закрывается уведомлением, есть пузырь с `<task-notification>`.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- ribbon`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/shared tests/unit
git commit -m "fix: subagent cards follow task_started, task_progress and task_notification (P3)"
```

---

### Task 2d: P4 — открытая заново сессия читается из её JSONL целиком

Находка E и вторая половина F. `getSessionMessages` (`TabController.ts:237-247` через `sessionHistory.ts`) отдаёт урезанную цепочку: нет `toolUseResult`, нет ничего до последнего сжатия, нет шагов подагентов, нет системных строк. Решение владельца: ленту восстанавливаем, **читая** файл сессии напрямую. Это чтение, не запись: ограничение раздела 9 спеки («не пишет файлы настроек и учётные данные») не нарушается, а в эти файлы Qclod не пишет никогда.

`SDKSessionInfo` пути к файлу не даёт (`sdk.d.ts:6217`), поэтому путь строится так же, как его строит SDK: `<CLAUDE_CONFIG_DIR или ~/.claude>/projects/<cwd с заменой [^a-zA-Z0-9] на '-'>/<sessionId>.jsonl` (`sl()` в `sdk.mjs`). Для длинных путей SDK укорачивает имя папки хешем — поэтому при промахе ищется `projects/*/<sessionId>.jsonl`, как `getSessionInfo` без `dir`.

Шаги подагентов читаются из `<sessionId>/subagents/agent-<agentId>.jsonl` тем же разборщиком. `getSubagentMessages` в SDK есть (`sdk.d.ts:978`), но отдаёт такие же урезанные сообщения, а под фейком SDK не грузится — один путь чтения, проверяемый e2e, надёжнее.

**Files:**
- Create: `src/main/agent/transcript.ts`
- Modify: `src/shared/types.ts` (карточка `compaction`), `src/shared/ribbon.ts:540-577,634-646` (`onUser`, `onCompaction`, `finishReplay`), `src/main/agent/AgentSession.ts:161-167` (`replay`), `src/main/tabs/TabController.ts:31,237-249` (`TabHistory`, `resume`), `src/main/index.ts:133-163`, `src/renderer/components/RibbonItem.tsx:171-180`
- Test: `tests/unit/transcript.test.ts` (новый), `tests/unit/ribbon.test.ts`, `tests/unit/tabController.test.ts`, `tests/e2e/history.spec.ts`

**Interfaces:**
- Consumes: `writeTranscript`, `resumedSession`, `encodeProjectDir` (Task 2a); разбор уведомлений и статусы карточек (Tasks 2b–2c).
- Produces:
  - `transcript.ts`:
    - `export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string` — `env.CLAUDE_CONFIG_DIR || join(home, '.claude')`.
    - `export function findTranscript(sessionId: string, cwd: string, configDir: string): string | null`.
    - `export async function readTranscript(path: string): Promise<unknown[]>` — сообщения в форме потока SDK, по порядку цепочки.
    - `export async function loadTranscript(sessionId: string, cwd: string, env?: NodeJS.ProcessEnv, home?: string): Promise<unknown[]>` — `[]`, если файла нет или он не читается; никогда не бросает.
  - Правила `readTranscript`:
    - Файл читается потоком (`createReadStream` + `readline`), только на чтение; строка, которая не парсится, пропускается.
    - Цепочка: от последней строки `user`/`assistant`/`attachment` с `isSidechain !== true` идти по `parentUuid` назад; у `compact_boundary` с `parentUuid: null` продолжать по `logicalParentUuid`; развернуть. Ветки, отрезанные перемоткой, в цепочку не попадают.
    - `user`/`assistant` → `{ type, uuid, message, parent_tool_use_id: null, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}), ...флаги }`, где флаги — `isSynthetic`, `isMeta`, `isCompactSummary`, `origin`, если есть в строке.
    - `system` с `subtype: 'compact_boundary'` → `{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger, pre_tokens: compactMetadata.preTokens, post_tokens: compactMetadata.postTokens } }`; прочие `system` (`turn_duration`, `stop_hook_summary`, `away_summary`) пропускаются.
    - `attachment` с `attachment.type === 'queued_command'` и `<task-notification>` в `attachment.prompt` → `{ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: prompt } }`; прочие `attachment`, `queue-operation`, `file-history-*`, `cost-state`, `mode`, `ai-title` и неизвестные типы пропускаются.
    - Сразу за `assistant`, где есть `tool_use` `Agent`/`Task`, вставляются шаги подагента: `agentId` берётся из `toolUseResult.agentId` ответа на этот `tool_use` (или из `meta.json` с тем же `toolUseId`), его файл читается теми же правилами (без вложенных подагентов), каждое сообщение получает `parent_tool_use_id` = id этого `tool_use`.
  - `TabHistory.transcript(sessionId: string, cwd: string): Promise<unknown[]>` вместо `messages(sessionId)`. В `index.ts`: настоящая — `loadTranscript(id, cwd)`; под фейком — `script.messages?.[id]`, если есть (тесты `history`/`formatting` не меняются), иначе тот же `loadTranscript` (e2e подкладывает файл через `CLAUDE_CONFIG_DIR` — это переменная самого CLI, не лазейка Qclod).
  - Карточка `compaction` получает `summary?: string`. `onUser`: сообщение с `isCompactSummary`, `isMeta` или `is_meta` пузыря не даёт; текст `isCompactSummary` записывается в `summary` последней карточки `compaction` (патч `update`). В ленте разделитель сжатия сворачиваемый: `<details>` «Что было до сжатия», внутри — сводка.
  - `RibbonBuilder.finishReplay(): RibbonChange[]` — после проигрыша истории всё, что ещё `running` (подагенты, инструменты), закрывается как в `closeOpen()` (`unfinished` / «не закончил»): процесс, который их вёл, закрылся вместе с приложением. `AgentSession.replay` вызывает его в конце.
  - Запись: ни одна функция `transcript.ts` не открывает файл на запись; тест проверяет, что содержимое и `mtimeMs` файла не меняются.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/transcript.test.ts — configDir = mkdtemp, файлы из writeTranscript(resumedSession(...))
test('путь ищется по cwd, а при промахе — во всех папках проектов', () => {
  // Review Focus 6: файл лежит в projects/<другое-имя>/<id>.jsonl
})
test('CLAUDE_CONFIG_DIR важнее домашней папки', () => {})
test('история до сжатия тоже читается, сжатие стоит между ними', async () => {
  // первый user 'найди, где падает вставка' присутствует; compact_boundary с pre_tokens 180000 после него
})
test('toolUseResult доходит как tool_use_result', async () => {})
test('шаги подагента приходят с parent_tool_use_id его вызова', async () => {})
test('уведомление из queued_command становится сообщением task-notification', async () => {})
test('ветка, отрезанная перемоткой, в историю не попадает', async () => {
  // Review Focus 7: нет 'старый вариант'
})
test('битая строка и служебные типы пропускаются', async () => {})
test('чтение не меняет файл', async () => {
  // readFileSync + statSync().mtimeMs до и после равны
})
test('нет файла — пустой список, без исключения', async () => {})
// tests/unit/ribbon.test.ts — builder.apply(…readTranscript…) + finishReplay()
test('восстановленная сессия: три подагента и честные статусы', () => {
  // 'Обзор вставки' done tokens 18000; 'Прогон тестов' done tokens 93175; 'Сборка' failed; 'Долгий обзор' unfinished
})
test('сводка сжатия — не пузырь, а часть разделителя', () => {
  // нет user с 'This session is being continued'; compaction.summary начинается с этого текста
})
// tests/unit/tabController.test.ts
test('resume читает транскрипт по cwd вкладки', async () => {
  // history.transcript вызван с (lastSessionId, tab.cwd)
})
```

В `tests/e2e/history.spec.ts` — тест «открытая из истории сессия показывает то, что было до сжатия»: `CLAUDE_CONFIG_DIR` = временная папка с `resumedSession`, `QCLOD_FAKE_HISTORY` с одной сессией без `messages`.

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/transcript.test.ts tests/unit/ribbon.test.ts tests/unit/tabController.test.ts`
Expected: FAIL — модуля нет; сводка сжатия — пузырь; `finishReplay` нет.

- [ ] **Step 3: Реализовать `transcript.ts` и переключить `resume` на него**

`SessionHistory.messages` и `getSessionMessages` больше не используются для resume; `SessionHistory.list` остаётся.

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- history formatting`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "fix: rebuild a resumed chat from its JSONL, compaction and subagents included (P4)"
```

---

### Task 2e: P5 — панель полна сразу: контекст, модель, лимиты, усилие

Находки G и H. Стоимость, лимиты и модель приходят только из `result`, `rate_limit_event` и `system/init` (`panelData.ts:46-61,101-146`), а настоящий CLI шлёт их лишь после первого сообщения. Контекст и список моделей уже спрашиваются при старте (`AgentSession.ts:316-318`); не хватает модели, лимитов и усилия.

**Files:**
- Modify: `src/main/agent/driver.ts`, `src/main/agent/sdkDriver.ts:147-183`, `src/main/agent/panelData.ts`, `src/main/agent/AgentSession.ts:230-319,366-384,500-509`, `src/main/agentIpc.ts:94-105`, `src/main/tabs/sanitize.ts:20-45`, `src/shared/types.ts` (`CostInfo`, `LaunchOverrides`), `src/renderer/components/SidePanel.tsx:136-200`
- Test: `tests/unit/sdkDriver.test.ts`, `tests/unit/panelData.test.ts`, `tests/unit/agentSession.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/e2e/panel.spec.ts`

**Interfaces:**
- Consumes: фейковые `planLimits()`, `getContextUsage().model`, `contextUsageDelayMs`, «молчание до первого сообщения» (Task 2a); `mockQuery()` (Task 2).
- Produces:
  - `ContextUsage.model?: string`; `AgentDriver.planLimits(): Promise<PanelData['limits'] | null>`.
  - `sdkDriver.planLimits()`: если у запроса нет функции `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (`sdk.d.ts:3176`) — `null`; иначе зовёт её с `{ skipBehaviors: true }`; `rate_limits_available === false` или `rate_limits === null` — `null`; окно `five_hour`/`seven_day` → `{ utilization: utilization / 100, resetsAt: Math.floor(Date.parse(resets_at) / 1000) }` (там 0–100 и ISO, у нас 0–1 и unix-секунды, как в `rate_limit_event`); окно с `utilization` или `resets_at` равным `null` → `null`; любое исключение → `null`, без записи в ленту.
  - `getContextUsage()` в `sdkDriver` пробрасывает `model`.
  - `AgentSession.start`: после `idle` — `refreshContext()` (ставит и `context`, и `model`, если ответ его принёс), `refreshModels()`, `refreshMcp()`, `refreshLimits()`; каждый вызов — с `.catch(() => undefined)` (Task 10 потом сведёт их в `background()`). Модель, пока неизвестна, берётся ещё из последнего `assistant` в истории (`message.model`) — через `PanelCollector.seedModel(model: string)` (зовёт `AgentSession.replay` после проигрыша истории), который не перезаписывает модель, уже пришедшую от процесса.
  - `PanelCollector.setLimits(limits)`; `rate_limit_event` по-прежнему обновляет лимиты по ходу.
  - Усилие: `LaunchOverrides.effort?: EffortLevel`; `sanitizeOverrides` пропускает только значения из `EFFORT_LEVELS`; IPC `agentEffort` после `setEffort` зовёт `controller.rememberOverride(id, { effort })`; `start()` при `overrides.effort` вызывает `driver.setEffort(effort)` и `collector.setEffort(effort)`. Хранится в `tabs.json` (файл Qclod), не в настройках пользователя.
  - Стоимость после resume: `CostInfo { session: number; sinceOpen?: boolean }`; `PanelCollector.markResumed()` (зовёт `start(resumeId)`) — дальше `onResult` ставит `sinceOpen: true`. Панель подписывает строку «с момента открытия» вместо «за сессию».
  - Выбор модели при `data.model === null`: первой стоит `<option value="" disabled>…</option>`, `value=''` — браузер не показывает чужую первую модель как выбранную. При `models.length === 0` и `model === null` — строка «…», не «появится после запуска», если сессия запущена.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/sdkDriver.test.ts
test('лимиты подписки спрашиваются с skipBehaviors и переводятся в 0..1 и unix-секунды', async () => {
  // usage_EXPERIMENTAL…({ skipBehaviors: true }) → { rate_limits_available: true, rate_limits: {
  //   five_hour: { utilization: 13, resets_at: '2026-11-10T15:00:00.000Z' }, seven_day: { utilization: 38, resets_at: '2026-11-14T00:00:00.000Z' } } }
  // planLimits() → { fiveHour: { utilization: 0.13, resetsAt: 1794322800 }, sevenDay: { utilization: 0.38, resetsAt: 1794614400 } }
})
test('нет метода usage — null, без исключения', async () => {})
test('rate_limits_available false — null', async () => {})
// tests/unit/agentSession.test.ts — фейк со steps: [] (молчит)
test('до первого сообщения панель знает контекст, модель, модели и лимиты', async () => {
  // start(); vi.waitFor: panel.context.percent 21, panel.model 'claude-opus-5', panel.models.length 2,
  // panel.limits.fiveHour.utilization 0.13; driver.sent пусто
})
test('сохранённое усилие вкладки применяется при старте и видно в панели', async () => {
  // overrides { effort: 'high' } → driver.effort 'high', panel.effort 'high'
})
test('после resume стоимость помечена «с момента открытия»', async () => {
  // start('old-id'); send; после result: panel.cost.sinceOpen === true
})
// tests/unit/panelData.test.ts
test('seedModel не перезаписывает модель от процесса', () => {})
// tests/unit/ipcValidation.test.ts
test('sanitizeOverrides пропускает только известные уровни усилия', () => {})
```

`tests/e2e/panel.spec.ts`: снять пометки `// снять в Task 2e` из Task 2a; новый тест «пока модель неизвестна, выбор показывает „…“, потом настоящую» — `contextUsageDelayMs: 1500`, сначала `panel-model` имеет значение `''` и текст `…`, потом `claude-opus-5`.

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/sdkDriver.test.ts tests/unit/agentSession.test.ts tests/unit/panelData.test.ts tests/unit/ipcValidation.test.ts`
Expected: FAIL — `planLimits` нет; `panel.model` и `limits` пусты до первого сообщения; усилие не сохраняется.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- panel`
Expected: PASS, пометки `test.fails` с «Task 2e» сняты и тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "fix: fill model, limits and effort in the panel before the first message (P5)"
```

---

### Task 2f: P6 — MCP не откатывается на «ждёт», окно может забрать панель целиком

Находки I и J. `system/init` перезаписывает живой ответ `mcpServerStatus` состоянием на момент старта (`pending`) (`panelData.ts:101-113`); MCP обновляется только при открытии панели (`App.tsx:130`). IPC `agentPanel` (`agentIpc.ts:119-122`) ничего не возвращает, хотя `preload` ждёт `PanelData` (`preload/index.ts:63`) — перезагруженное окно или пропущенное событие оставляет панель пустой.

**Files:**
- Modify: `src/main/agent/panelData.ts`, `src/main/agent/AgentSession.ts` (`onPanel`, `onMessage`, `refreshMcp`, `dispose`), `src/main/tabs/TabController.ts` (`panelOf`, `wire`), `src/main/agentIpc.ts:119-122`, `src/main/index.ts:168`, `src/preload/index.ts:63`, `src/shared/types.ts` (`PanelEvent`, `PanelSnapshot`), `src/renderer/state/useAppStore.ts:33,48,94,135-140`, `src/renderer/app/App.tsx:110-131,185-201`
- Test: `tests/unit/panelData.test.ts`, `tests/unit/agentSession.test.ts`, `tests/unit/tabController.test.ts`, `tests/unit/appStore.test.ts` (новый; Task 11 потом его дополняет), `tests/e2e/panel.spec.ts`

**Interfaces:**
- Consumes: фейковые `init.mcpServers` и `mcpServerStatus()` (Task 2a); `PanelCollector` из Task 2e.
- Produces:
  - `PanelCollector.setMcp(list: McpServerInfo[]): Partial<PanelData>` — с первого живого ответа `onInit` поле `mcp` больше не трогает.
  - `AgentSession` спрашивает `mcpServerStatus()`: при старте, сразу после `init`, на `system/commands_changed` и `system/plugin_install`; пока хоть один сервер `pending` или `connecting` — повтор каждые `MCP_POLL_MS = 2000` мс, не больше `MCP_POLL_MAX = 15` раз; таймер гасится в `dispose()`.
  - Ревизии панели: в `panelData.ts` модульный счётчик `nextPanelRev()` — общий на процесс, чтобы новая сессия вкладки (restart, восстановление) не начинала с нуля. `PanelCollector.rev: number` — ревизия последнего патча. `PanelEvent { tabId; patch; rev: number }`. `export interface PanelSnapshot { rev: number; data: PanelData }`.
  - `AgentSession.onPanel(cb: (patch: Partial<PanelData>, rev: number) => void)`; `AgentSession.panelSnapshot(): PanelSnapshot`.
  - `TabController.panelOf(id: TabId): PanelSnapshot` — снимок сессии, иначе `{ rev: 0, data: EMPTY_PANEL }` (Task 2g добавит снимок превью).
  - IPC `agentPanel(id)` возвращает `controller.panelOf(id)` сразу, а `refreshMcp()` запускает в фоне (ответ придёт событием). `preload.panel(id): Promise<PanelSnapshot>`.
  - Стор: `panelRevByTab: Record<TabId, number>`; `applyPanel(id, patch, rev)` применяет патч и запоминает `rev`, если `rev` больше запомненного; `setPanelSnapshot(id, snapshot)` заменяет данные целиком, только если `snapshot.rev >= panelRevByTab[id] ?? -1`. Старый снимок не затирает свежие события — та же гонка, что описана у `ribbon` в `App.tsx:191-195`.
  - `App.tsx`: снимок панели запрашивается при монтировании для активной вкладки (и вкладки сплита), при каждой смене активной вкладки и при открытии панели.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/panelData.test.ts
test('init не откатывает живой статус MCP на pending', () => {
  // setMcp([{ name:'unity', status:'connected' }]); apply(init с mcp_servers [{ name:'unity', status:'pending' }])
  // data.mcp[0].status === 'connected'
})
test('ревизия растёт и у новой сессии продолжается, а не начинается с нуля', () => {})
// tests/unit/agentSession.test.ts
test('после init MCP спрашивается заново', async () => {})
test('сервер в pending опрашивается, пока не подключится', async () => {
  // fake.mcpServerStatus: 1-й ответ pending, 2-й connected; MCP_POLL_MS подменён через опцию mcpPollMs: 10
})
// tests/unit/tabController.test.ts
test('panelOf отдаёт полный снимок панели вкладки', async () => {})
// tests/unit/appStore.test.ts
test('старый снимок не затирает более свежий патч', () => {
  // applyPanel('a', { model:'x' }, 5); setPanelSnapshot('a', { rev: 3, data: {...EMPTY_PANEL, model:'old'} }) → model 'x'
})
test('снимок новее — заменяет всё', () => {})
```

Для теста опроса — `AgentSessionOptions.mcpPollMs?: number` (по умолчанию `MCP_POLL_MS`).

`tests/e2e/panel.spec.ts`: снять пометки `// снять в Task 2f`; новый тест «после перезагрузки окна панель снова полная» — `win.reload()`, без нового сообщения `panel-context` и `panel-model` снова заполнены.

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/panelData.test.ts tests/unit/agentSession.test.ts tests/unit/tabController.test.ts tests/unit/appStore.test.ts`
Expected: FAIL — `connected` откатился на `pending`; `panelOf`, `setPanelSnapshot`, `rev` нет.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- panel launch`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "fix: live MCP status survives init; the window can fetch the whole panel (P6)"
```

---

### Task 2g: P7 — фоновая восстановленная вкладка видна без запуска процесса

Находка K. `TabController.restore` поднимает только активную вкладку (`:104`); остальные до клика пусты и пишут «появится после запуска». Раздел 9 спеки («агент стартует у вкладки при первом переходе») сохраняется: процесс не запускается, лента и панель строятся из транскрипта **чтением**.

**Files:**
- Modify: `src/main/tabs/TabController.ts` (`restore`, `ensureSession`, `resume`, `recoverFromDeadSession`, `itemsOf`, `panelOf`, `wire`), `src/main/agent/AgentSession.ts` (конструктор, `replay`), `src/main/agent/AgentSessionManager.ts:26`, `src/main/agent/panelData.ts`, `src/shared/types.ts` (`ContextInfo`), `src/renderer/components/SidePanel.tsx:115-133`
- Test: `tests/unit/tabController.test.ts`, `tests/unit/panelData.test.ts`

**Interfaces:**
- Consumes: `TabHistory.transcript(sessionId, cwd)` и `RibbonBuilder.finishReplay()` (Task 2d); `seedModel`, `setLimits` (Task 2e); `PanelSnapshot`, `panelOf` (Task 2f).
- Produces:
  - `export interface SessionSeed { builder: RibbonBuilder; collector: PanelCollector }`. `AgentSessionOptions.seed?: SessionSeed` — сессия берёт эти builder и collector вместо новых; `AgentSessionManager.create(tabId, cwd, overrides, seed?: SessionSeed)`.
  - `TabController`: `private readonly previews = new Map<TabId, SessionSeed>()`; `private async preview(id: TabId): Promise<SessionSeed | null>` — для вкладки с `lastSessionId` и без `missingCwd` читает транскрипт, проигрывает его в новый `RibbonBuilder` + `finishReplay()`, заполняет `PanelCollector` (`seedFromTranscript`), отдаёт в окно ленту (`onRibbon`, все элементы как `append`) и панель (`onPanel`). Повторный вызов отдаёт уже построенное.
  - `restore()`: `preview` для **каждой** восстановленной вкладки (через `track`), процесс — только для активной, как сейчас.
  - `ensureSession`: сначала `await this.preview(id)`, затем `manager.create(..., seed)` и `previews.delete(id)`; `resume()` транскрипт больше не читает и `replay` не зовёт — лента уже в окне, а новые элементы продолжают нумерацию того же builder-а, без повторов и без столкновения id.
  - `recoverFromDeadSession`: новая сессия получает `{ builder: <builder мёртвой>, collector: new PanelCollector() }` через `AgentSession.successorSeed(): SessionSeed` — история остаётся на экране, id новых элементов не совпадают со старыми.
  - `itemsOf(id)` и `panelOf(id)` при отсутствии сессии отдают данные превью.
  - `PanelCollector.seedFromTranscript(messages: unknown[]): Partial<PanelData>` — модель из `message.model` последнего `assistant`; контекст-оценка из его `message.usage`: `used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, `max = model.includes('[1m]') ? 1_000_000 : 200_000`, `percent = Math.round(used / max * 100)`, `categories: []`, `estimated: true`. `ContextInfo.estimated?: boolean`; панель показывает «≈ 23% из 200k · по записи», пока процесс не дал настоящий ответ (тот перезаписывает).
  - Лимиты общие для аккаунта: когда любая вкладка получила патч с `limits`, `TabController` применяет тот же `limits` к collector-у каждого превью без сессии и шлёт `onPanel` для него.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/tabController.test.ts — две вкладки в tabs.json с lastSessionId; history.transcript отдаёт readTranscript(resumedSession)
test('фоновая вкладка показывает ленту и подагентов без запуска процесса', async () => {
  // restore(); await whenSettled()
  // manager.create вызван 1 раз (только активная); itemsOf('b') содержит 4 карточки subagent
})
test('панель фоновой вкладки знает модель и оценку контекста из записи', async () => {
  // panelOf('b').data.model 'claude-opus-5'; context.estimated true; context.used 45674
})
test('переход на фоновую вкладку не дублирует ленту', async () => {
  // activate('b'); после старта itemsOf('b') — те же id, без повторов; transcript для 'b' прочитан 1 раз
})
test('лимиты, узнанные активной вкладкой, видны и фоновой', async () => {})
test('восстановление мёртвой сессии оставляет историю и не повторяет id', async () => {})
// tests/unit/panelData.test.ts
test('seedFromTranscript: окно 1M для модели с [1m]', () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/tabController.test.ts tests/unit/panelData.test.ts`
Expected: FAIL — `itemsOf('b')` пуст, `panelOf('b')` — пустая панель.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- history launch`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src tests/unit
git commit -m "fix: restored background tabs show their chat and panel without starting (P7)"
```

---

### Task 2h: P8 — сквозной тест «вошёл в сессию — всё видно сразу»

Главная жалоба владельца одним тестом, против исправленного фейка: открыть восстановленную сессию и, **ничего не отправляя**, увидеть контекст, лимиты, модель и подагентов с верными статусами.

**Files:**
- Create: `tests/e2e/resumedPanel.spec.ts`

**Interfaces:**
- Consumes: `writeTranscript`, `resumedSession` (Task 2a); всё из Tasks 2b–2g. Формат `tabs.json` — `saveTabs` из `src/main/store/tabsStore.ts`.

- [ ] **Step 1: Написать тест**

Подготовка: профиль `QCLOD_USER_DATA` с `tabs.json` из двух вкладок (`cwd` — временная папка проекта, у обеих `lastSessionId`); `CLAUDE_CONFIG_DIR` — временная папка с `resumedSession` для обеих; `QCLOD_FAKE_SDK_SCRIPT` — `{ steps: [] }` (фейк молчит).

```ts
test('восстановленная сессия: панель и подагенты видны до первого сообщения', async () => {
  // panel-context содержит '%'; panel-limits содержит '13%' и '38%'; panel-model имеет значение 'claude-opus-5'
  // panel-agents li: 4 шт.; тексты состояний: 'готов' ×2, 'ошибка', 'не закончил'; у 'Прогон тестов' — '93k токенов'
  // в ленте есть 'найди, где падает вставка' (до сжатия) и разделитель сжатия; ни одного пузыря пользователя
  //   с 'task-notification' или 'This session is being continued'
  // ни одного сообщения не отправлено: в ленте нет user-элементов, кроме двух из истории
})
test('вторая вкладка до клика уже содержит свою ленту и подагентов', async () => {
  // переключение на вторую вкладку: panel-agents сразу 4 шт., без ожидания процесса
})
test('после перезагрузки окна всё на месте', async () => {
  // win.reload(); снова те же проверки панели
})
```

- [ ] **Step 2: Прогнать на коде до Tasks 2b–2g, убедиться что падает**

Если задачи уже сделаны — проверить на `git stash` их правок или на коммите Task 2a: `git checkout <коммит 2a> -- src && npm run test:e2e -- resumedPanel`, затем `git checkout HEAD -- src`.
Expected: FAIL — панель пуста, подагенты «готов» или пропали.

- [ ] **Step 3: Прогнать на текущем коде**

Run: `npm run test:e2e -- resumedPanel`
Expected: PASS.

- [ ] **Step 4: Полный прогон и коммит**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e`
Expected: PASS, ни одной пометки `test.fails`/`test.fail()` из Task 2a не осталось (`git grep -n "снять в Task 2"` пуст).

```bash
git add tests/e2e/resumedPanel.spec.ts
git commit -m "test: a resumed session shows its panel and subagents before any message (P8)"
```

---

### Task 3: B3 + B5 — ожидающие вопросы отменяются, статус считает их все

**Files:**
- Modify: `src/main/agent/AgentSession.ts` (`interrupt`, `onToolPermission`, `askPlan`, `askQuestion`, `dispose`), `src/main/agent/permissions.ts` (`request`), `src/main/agent/AgentSessionManager.ts`, `src/main/index.ts:128-129`
- Test: `tests/unit/agentSession.test.ts`, `tests/unit/permissions.test.ts`

**Interfaces:**
- Consumes: `ToolPermissionContext.signal` (Task 2); фейковый шаг `askPermissions` (Task 2).
- Produces:
  - `AgentSessionOptions.askPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>` (и то же в `AgentSessionManagerOptions`).
  - `PermissionBroker.request(tabId, toolName, input, knownRequestId?: string, signal?: AbortSignal)`: аборт сигнала → запрос удаляется из `pending`, резолвится `{ behavior: 'deny' }`, правило не сохраняется; поздний `answer()` игнорируется.
  - В `AgentSession` — счётчик ожиданий: `enterWait()` (+1, статус `waiting`) и `leaveWait()` (−1; на нуле и при статусе `waiting` → `busy`). Переменная `previous` уходит из всех трёх мест.
  - `AgentSession.interrupt()`: абортит свой `AbortController` каждого открытого разрешения (сигнал SDK привязан к нему же), резолвит `pendingQuestions` и `pendingPlans` отказом, помечает карточки (`resolvePermission(id, 'denied')`, `resolvePlan(id, 'rejected')`), обнуляет счётчик, потом `driver.interrupt()` и `idle`. Тот же сброс зовёт `dispose()`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/permissions.test.ts
test('аборт сигнала отклоняет запрос и убирает его из ожидающих', async () => {
  // request(..., 'r1', ctrl.signal); ctrl.abort() → resolves { behavior: 'deny' }
  // answer('r1', { behavior: 'allow', remember: true }) → правил не прибавилось
})

// tests/unit/agentSession.test.ts — с настоящим PermissionBroker в askPermission
describe('AgentSession: стоп во время вопроса', () => {
  test('стоп отменяет ожидающее разрешение, поздний клик не возвращает «работает»', async () => {
    // nextTurn: [askPermission Bash]; send → ждём 'waiting'; interrupt()
    // статус 'idle', карточка 'denied'; broker.answer(id, allow) → через тик статус всё ещё 'idle'
  })
  test('стоп отменяет ожидающий план', async () => {})
  test('клик по варианту вопроса после стопа уходит сообщением и ход кончается idle', async () => {
    // Review Focus 4. steps: [askQuestion], nextTurn: [text 'ок'] — nextTurn без вопроса,
    // иначе отправленный выбор снова откроет вопрос. Ждём 'waiting'; interrupt; answerQuestion(id, 'Справа')
    // driver.sent.at(-1).text === 'Справа'; vi.waitFor → статус 'idle', в ленте 'ок'
  })
  test('стоп в одной вкладке не трогает ожидающий запрос другой', async () => {
    // Review Focus 3. Две сессии t1, t2 на одном брокере; обе ждут; interrupt t1
    // запрос t2 по-прежнему в брокере, ответ allow → инструмент t2 выполнен
  })
})
describe('AgentSession: два разрешения сразу', () => {
  test('ответ на одно оставляет «ждёт», пока ждёт второе', async () => {
    // nextTurn: [askPermissions [Bash, Edit]]; ответ на первый → статус 'waiting'
    // ответ на второй → 'busy', после result → 'idle'
  })
})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/agentSession.test.ts tests/unit/permissions.test.ts`
Expected: FAIL — после позднего клика статус `busy`; после первого из двух ответов `busy` вместо `waiting`.

- [ ] **Step 3: Починить по интерфейсам выше**

`index.ts`: `askPermission: (r, signal) => broker.request(r.tabId, r.toolName, r.input, r.requestId, signal)`.

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e -- permissions planmode`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main tests/unit
git commit -m "fix: stop cancels pending asks, status counts every open ask (B3, B5)"
```

---

### Task 4: B4 — мёртвая сессия при resume заменяется и забывается

**Files:**
- Modify: `src/main/tabs/TabController.ts` (`restart`, `resume`, `recoverFromDeadSession` — номера строк сдвинуты Tasks 2d и 2g), `src/main/agent/AgentSession.ts` (`onStatus` возвращает отписку)
- Test: `tests/unit/tabController.test.ts`

**Interfaces:**
- Consumes: после Task 2g `resume()` транскрипт не читает (лента уже построена превью), а `recoverFromDeadSession` создаёт новую сессию с `dead.successorSeed()` — сохранить это при переделке.
- Produces: `AgentSession.onStatus(cb: StatusListener): () => void` — возвращает функцию отписки (остальные `on*` не меняются). В `TabController.resume`: если после `start(resumeId)` статус уже `error` — восстановить сразу; иначе подписаться на статус и восстановить на первом `error`, пока `session.sessionId === null` (сессия ещё не представилась `init`-ом); после `init` или восстановления — отписаться. `whenIdle()` отсюда уходит. `recoverFromDeadSession` и `restart` после `delete tab.lastSessionId` вызывают `this.persist()`; `recoverFromDeadSession` ставится через `this.track(...)`, а не `void`.

- [ ] **Step 1: Падающие тесты**

В `makeController` — опция `resumeFailsAfterMs?: number`: драйвер для resume, чей `messages` ждёт `setTimeout(ms)` и бросает `Error('No conversation found with session ID: …')`; свежая сессия — «молчащий» драйвер (поток ждёт `dispose`, `init` не выдаёт, как настоящий CLI до первого сообщения).

```ts
test('resume, который падает позже старта, всё равно заменяется чистой сессией', async () => {
  // resumeFailsAfterMs: 50; restore(); vi.waitFor → notice 'Прошлую переписку открыть не удалось'
  // статус вкладки не 'error'; manager.get('a') — новая сессия
})
test('мёртвый id стирается из tabs.json сразу, а не после первого ответа', async () => {
  // после восстановления: JSON tabs.json[0].lastSessionId === undefined
})
test('restart тоже сразу забывает прежний id на диске', async () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/tabController.test.ts`
Expected: FAIL — notice нет, вкладка в `error`, `lastSessionId` на диске прежний.

- [ ] **Step 3: Починить по интерфейсу выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/tabController.test.ts tests/unit/agentSession.test.ts && npm run test:e2e -- history`
Expected: PASS, включая прежние тесты «синхронно» и «на лету».

- [ ] **Step 5: Коммит**

```bash
git add src/main tests/unit/tabController.test.ts
git commit -m "fix: recover from a resume that dies after start, forget its id on disk (B4)"
```

---

### Task 5: B2 — Claude Code из npm запускается

Выбранный путь: на Windows кандидатами служат только файлы, которые можно запустить без shell; npm-обёртка (`.cmd`/`.bat`) разворачивается в то, на что она указывает. Сегодня это `node_modules\@anthropic-ai\claude-code\bin\claude.exe` (нативный exe, `npm view` 2.1.321); у старых версий — `cli.js`, который SDK сам запускает через `node`. Обёртка читается, а не угадывается по `%APPDATA%\npm`: так работают и свой префикс npm, и пути с пробелами.

**Files:**
- Modify: `src/main/agent/resolveExecutable.ts`, `src/main/setup/findAgent.ts:100-155`, `src/main/setup/environment.ts:38`
- Test: `tests/unit/resolveExecutable.test.ts`, `tests/unit/environment.test.ts`

**Interfaces:**
- Produces:
  - `unwrapShim(path: string): string | null` в `resolveExecutable.ts`: читает файл, находит все пути вида `%dp0%\…` (до закрывающей кавычки), отбрасывает оканчивающиеся на `node.exe`, берёт последний, разрешает относительно папки обёртки; возвращает его, если это существующий `.exe` или `.js`, иначе `null`.
  - `resolveExecutable(requested, env)`: на `win32` порядок кандидатов — `.exe`, `.com` (если есть в PATHEXT), затем прочие расширения PATHEXT в их порядке; голое имя без расширения не кандидат. Найденный `.cmd`/`.bat` проходит через `unwrapShim`; `null` → ищем дальше, в конце — `AgentNotFoundError` с текстом про `.cmd`, который нельзя запустить напрямую. Явно указанный `.cmd` (абсолютный путь) тоже разворачивается.
  - `findAgent`: из известных мест убираются кандидаты без расширения; добавляется `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`; каждое место проверяется через `resolveExecutable(место, env)`, а не `existsSync`.
  - `environment.ts`: версия `.js` спрашивается как `node <путь> --version`, остального — как раньше.

- [ ] **Step 1: Падающие тесты на временной папке**

Помощник `npmFixture(root: string, kind: 'exe' | 'js')` создаёт в `root`: `claude` (sh-скрипт), `claude.cmd` (текст настоящей обёртки cmd-shim: для `exe` — строка `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`; для `js` — `IF EXIST "%dp0%\node.exe"…` и `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`) и целевой файл. Для `exe` целевой файл — жёсткая ссылка на `process.execPath` (`linkSync`, при ошибке — `copyFileSync`), чтобы его можно было реально запустить.

```ts
test('npm-установка: находится настоящий claude.exe, а не sh-скрипт и не .cmd', () => {
  // resolveExecutable('claude', { PATH: root, PATHEXT: '.COM;.EXE;.BAT;.CMD' })
  //   === join(root,'node_modules','@anthropic-ai','claude-code','bin','claude.exe')
})
test('найденный файл действительно запускается без shell', () => {
  // execFileSync(resolved, ['--version']) не бросает (это node.exe под чужим именем)
})
test('старый npm-пакет: обёртка разворачивается в cli.js', () => {})
test('путь с пробелом и кириллицей', () => {
  // Review Focus 1: root = mkdtemp(join(tmpdir(), 'Иван Петров npm-'))
})
test('свой префикс npm где-то в PATH', () => {
  // Review Focus 2: обёртка в произвольной папке, PATH: `${other};${root}`
})
test('.cmd, который не обёртка npm, — понятная ошибка, а не EINVAL', () => {})
test('при .CMD раньше .EXE в PATHEXT всё равно берётся .exe', () => {
  // заменяет прежний тест «расширение подбирается по PATHEXT в его порядке»:
  // .cmd без shell не запускается, поэтому порядок PATHEXT для него больше не главный
})
// tests/unit/environment.test.ts
test('findAgent без PATH находит npm-установку в APPDATA и отдаёт exe', () => {
  // env = { APPDATA: root-родитель с папкой npm, PATH: '' }
})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/resolveExecutable.test.ts tests/unit/environment.test.ts`
Expected: FAIL — возвращается `…\claude` (без расширения) или `…\claude.cmd`; `execFileSync` даёт ENOENT/EINVAL.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/resolveExecutable.test.ts tests/unit/environment.test.ts tests/unit/agentSession.test.ts && npm run test:e2e -- setup`
Expected: PASS (включая «находит установленный агент» — winget-exe на этой машине).

- [ ] **Step 5: Коммит**

```bash
git add src/main/agent/resolveExecutable.ts src/main/setup tests/unit
git commit -m "fix: run the real claude.exe behind an npm shim, never the shim (B2)"
```

---

### Task 6: B6 — отмена установки убивает всё дерево, вторая установка ждёт

**Files:**
- Modify: `src/main/setup/install.ts:121-132`, `src/main/ipc.ts:47-62`
- Test: `tests/unit/install.test.ts` (новый)

**Interfaces:**
- Produces:
  - `runInstaller(command: string, args: string[], onOutput: (line: string) => void, onDone: (ok: boolean) => void): InstallHandle` — то, что сейчас тело `installAgent` после `commandFor`; `installAgent(method, …)` зовёт его. `onDone` вызывается ровно один раз (`error` и `close` могут прийти оба).
  - `InstallHandle.cancel()` на `win32` запускает `taskkill /pid <pid> /T /F` (`windowsHide: true`), на прочих — `child.kill()`; пишет в вывод «Отменено.».
  - `class InstallSlot { get busy(): boolean; start(begin: (done: (ok: boolean) => void) => InstallHandle | Promise<InstallHandle>): Promise<boolean> | null; cancel(): void }` в `install.ts`. `start` занимает слот синхронно, возвращает `null`, если занят; слот освобождается только в `done`, а не в `cancel`.
  - `ipc.ts`: один `InstallSlot`; `setupInstall` при занятом слоте пишет «Установка уже идёт.» и возвращает `false`; `detectInstallMethod()` вызывается внутри `begin`, чтобы два быстрых клика не прошли оба.

- [ ] **Step 1: Падающие тесты**

Сценарий дерева процессов пишется во временные файлы: `parent.js` запускает `child.js` (`setInterval(() => {}, 1000)`), печатает `CHILD <pid>` и висит сам. Запуск — `runInstaller('node', [parentPath], …)` (с тем же `shell: true`, что у настоящей установки).

```ts
test('отмена убивает и внука, а не только cmd.exe', async () => {
  // дождаться строки CHILD <pid>; handle.cancel(); дождаться onDone(false)
  // vi.waitFor: process.kill(pid, 0) бросает ESRCH
})
test('onDone вызывается один раз', async () => {})
test('слот не даёт начать вторую установку, пока идёт первая', async () => {
  // start(...) → Promise; второй start(...) → null
})
test('после отмены слот занят, пока процесс не умер, потом свободен', async () => {
  // Review Focus 5: cancel(); сразу start → null; после done → start снова Promise
})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/install.test.ts`
Expected: FAIL — `runInstaller`/`InstallSlot` не экспортированы; после того как появятся (до правки `cancel`) — внук жив.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/install.test.ts tests/unit/environment.test.ts && npm run test:e2e -- setup`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/setup/install.ts src/main/ipc.ts tests/unit/install.test.ts
git commit -m "fix: cancelling an install kills the whole tree; one install at a time (B6)"
```

---

### Task 7: B7 — новая вкладка установленного приложения открывается в домашней папке

**Files:**
- Create: `src/main/tabs/defaultCwd.ts`
- Modify: `src/main/index.ts:156`
- Test: `tests/unit/defaultCwd.test.ts` (новый)

**Interfaces:**
- Produces: `pickDefaultCwd(isPackaged: boolean, cwd: string, home: string): string` — собранное приложение → `home`; разработка → `cwd || home`. `index.ts`: `defaultCwd: pickDefaultCwd(app.isPackaged, process.cwd(), homedir())`.

- [ ] **Step 1: Падающий тест**

```ts
test('собранное приложение не открывает вкладку в папке установки или System32', () => {
  expect(pickDefaultCwd(true, 'C:\\Windows\\System32', 'C:\\Users\\u')).toBe('C:\\Users\\u')
  expect(pickDefaultCwd(true, 'C:\\Users\\u\\AppData\\Local\\Programs\\Qclod', 'C:\\Users\\u')).toBe('C:\\Users\\u')
})
test('в разработке остаётся текущая папка', () => {
  expect(pickDefaultCwd(false, 'C:\\repo', 'C:\\Users\\u')).toBe('C:\\repo')
  expect(pickDefaultCwd(false, '', 'C:\\Users\\u')).toBe('C:\\Users\\u')
})
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/unit/defaultCwd.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать и подключить в `index.ts`**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/defaultCwd.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/tabs/defaultCwd.ts src/main/index.ts tests/unit/defaultCwd.test.ts
git commit -m "fix: a new tab in the installed app opens in the home folder (B7)"
```

---

### Task 8: B8 — закрытие не виснет и не оставляет процесс

**Files:**
- Modify: `src/main/agent/sdkDriver.ts:185-193`, `src/main/agent/AgentSession.ts` (`dispose`, `fail`), `src/main/agent/AgentSessionManager.ts`
- Test: `tests/unit/sdkDriver.test.ts`, `tests/unit/agentSession.test.ts`

**Interfaces:**
- Consumes: `mockQuery()` из `tests/unit/sdkDriver.test.ts` (Task 2).
- Produces:
  - `sdkDriver.dispose()`: `closed = true`, будит `prompt()`, вызывает `session.close()` (синхронный, из `sdk.d.ts:3373`); `session.return()` больше не зовётся.
  - `export const DISPOSE_TIMEOUT_MS = 5000` в `AgentSession.ts`; `AgentSessionOptions.disposeTimeoutMs?: number` (и проброс из `AgentSessionManagerOptions`). `dispose()` ждёт `driver.dispose()` + `pump` не дольше этого срока, после чего всё равно ставит `stopped`.
  - `fail()` закрывает драйвер: `void driver.dispose().catch(() => undefined)` для того драйвера, что был.

Таймаут на уровне сессии ограничивает и закрытие вкладки, и выход (`index.ts:237` ждёт `disposeAll()`, который состоит из тех же `dispose()`), поэтому отдельный таймер в `index.ts` не нужен.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/sdkDriver.test.ts
test('dispose закрывает запрос SDK через close(), а не return()', async () => {
  // fakeQuery().close вызван 1 раз; return не вызван
})
// tests/unit/agentSession.test.ts
test('упавшая сессия закрывает свой драйвер', async () => {
  // steps: [crash]; после whenIdle: driver.disposed === true
})
test('драйвер, который не закрывается, не держит dispose дольше срока', async () => {
  // драйвер с dispose: () => new Promise(() => {}); disposeTimeoutMs: 50
  // await session.dispose() завершается < 1000 мс, статус 'stopped'
})
test('disposeAll менеджера тоже не виснет на таком драйвере', async () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падают**

Run: `npx vitest run tests/unit/sdkDriver.test.ts tests/unit/agentSession.test.ts`
Expected: FAIL — `close` не вызван; `disposed` false; таймаут теста на зависшем `dispose`.

- [ ] **Step 3: Починить по интерфейсам выше**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/agent tests/unit
git commit -m "fix: close the SDK query for real, bound shutdown, dispose a failed driver (B8)"
```

---

### Task 9: B9 — прикреплённый файл уходит агенту один раз

Текст составляет только `composeText` в `AgentSession.send` (так решено ещё в v2, см. комментарий `userMessage.ts`). Драйвер перестаёт его достраивать.

**Files:**
- Modify: `src/main/agent/sdkDriver.ts:12-48`
- Test: `tests/unit/sdkDriver.test.ts`

**Interfaces:**
- Consumes: `mockQuery()` (Task 2) — тест читает первое сообщение из запомненного `prompt`.
- Produces: `toSdkMessage(input)` кладёт `input.text` как есть, из вложений берёт только картинки; локальная `mention()` в `sdkDriver.ts` удаляется.

- [ ] **Step 1: Падающий тест**

```ts
test('файл упоминается в тексте ровно один раз', async () => {
  // driver.send({ text: 'посмотри\n@"C:\\Мои проекты\\файл 1.ts"',
  //               attachments: [{ kind: 'file', path: 'C:\\Мои проекты\\файл 1.ts' }] })
  // первое сообщение из prompt: content[0].text — вхождений '@"C:\\Мои проекты\\файл 1.ts"' ровно 1
})
test('картинка по-прежнему уходит блоком image', async () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/unit/sdkDriver.test.ts`
Expected: FAIL — вхождений 2.

- [ ] **Step 3: Починить**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/sdkDriver.test.ts tests/unit/agentSession.test.ts && npm run test:e2e -- composer`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/agent/sdkDriver.ts tests/unit/sdkDriver.test.ts
git commit -m "fix: attachments are mentioned to the agent once, not twice (B9)"
```

---

### Task 10: B11 — фоновые обновления панели не дают unhandled rejection

**Files:**
- Modify: `src/main/agent/AgentSession.ts:316-318,462,485`
- Test: `tests/unit/agentSession.test.ts`

**Interfaces:**
- Produces: `private background(work: Promise<unknown>): void` — вешает `.catch(() => undefined)`. Все `void this.refreshX()` в `AgentSession` идут через него, включая добавленные в Tasks 2e–2f `refreshLimits`, `refreshMcp` после `init` и опрос MCP (там пока стоят `.catch(() => undefined)` на месте). (`TabController` переведён на `track()` в Task 4.)

- [ ] **Step 1: Падающий тест**

```ts
test('драйвер без supportedModels/mcpServerStatus не роняет процесс', async () => {
  // driver = createFakeSdk({}); delete driver.supportedModels; delete driver.mcpServerStatus
  // const seen: unknown[] = []; const h = (e: unknown) => seen.push(e)
  // process.on('unhandledRejection', h); start(); whenIdle(); await new Promise(r => setTimeout(r, 20))
  // process.off('unhandledRejection', h); expect(seen).toEqual([])
})
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/unit/agentSession.test.ts`
Expected: FAIL — `seen` содержит `TypeError: driver.supportedModels is not a function`.

- [ ] **Step 3: Починить**

- [ ] **Step 4: Прогнать весь набор и проверить, что ошибок нет**

Run: `npm run test:unit`
Expected: все PASS и в выводе **нет** блока «Unhandled Errors» (сейчас он есть — из `tabController.test.ts`).

- [ ] **Step 5: Коммит**

```bash
git add src/main/agent/AgentSession.ts tests/unit/agentSession.test.ts
git commit -m "fix: background panel refreshes never surface as unhandled rejections (B11)"
```

---

### Task 11: B12 — данные закрытых вкладок уходят из стора окна

**Files:**
- Modify: `src/renderer/state/useAppStore.ts:106-122`
- Test: `tests/unit/appStore.test.ts` (создан в Task 2f; zustand работает в node без DOM)

**Interfaces:**
- Produces: `setTabs(tabs)` удаляет из `ribbonByTab`, `todoByTab`, `panelByTab`, `panelRevByTab` (Task 2f), `draftByTab`, `attachmentsByTab`, `fileIndexByTab` ключи вкладок, которые были в прежнем `state.tabs` и пропали из нового. Ключи вкладок, которых стор ещё не видел в `tabs`, не трогаются: события ленты новой вкладки могут прийти раньше списка, полученного по `tabsList`.

- [ ] **Step 1: Падающие тесты**

```ts
test('закрытая вкладка не оставляет ленту, панель, черновик и индекс файлов', () => {
  // setTabs([A, B]); applyRibbon('B', [...]); applyPanel('B', {...}); setDraft('B','x'); setFileIndex('B',['a'])
  // setTabs([A]) → ни в одном *ByTab нет ключа 'B'; данные 'A' на месте
})
test('лента вкладки, ещё не пришедшей в списке, не стирается', () => {
  // setTabs([A]); applyRibbon('C', [...]); setTabs([A]) → ribbonByTab.C на месте
})
```

Перед каждым тестом стор сбрасывается: `useAppStore.setState(useAppStore.getInitialState(), true)`.

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/unit/appStore.test.ts`
Expected: FAIL — ключ `B` остался.

- [ ] **Step 3: Починить**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/appStore.test.ts && npm run test:e2e -- launch ribbon`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer/state/useAppStore.ts tests/unit/appStore.test.ts
git commit -m "fix: forget a closed tab's ribbon, panel and drafts in the renderer (B12)"
```

---

### Task 12: B13 — «готов» не обгоняет последний кусок текста

**Files:**
- Create: `src/main/rendererOutbox.ts`
- Modify: `src/main/index.ts:77-80,151-185`
- Test: `tests/unit/rendererOutbox.test.ts` (новый)

**Interfaces:**
- Consumes: `RibbonBatcher` (без изменений).
- Produces: `class RendererOutbox { constructor(send: (channel: string, payload: unknown) => void, frameMs?: number); ribbon(event: RibbonEvent): void; send(channel: string, payload: unknown): void; flush(): void }`. `ribbon()` копит через `RibbonBatcher` и отдаёт в `CHANNELS.ribbonChanged`; `send()` сначала сбрасывает накопленную ленту, потом шлёт своё. В `index.ts` все `send(...)` из `TabController` (`onChanged`, `onPanel`, `onStatus`, `onCommands`, `activateTab`) идут через `outbox.send`.

- [ ] **Step 1: Падающий тест**

```ts
test('статус уходит после накопленной ленты той же вкладки', () => {
  // outbox.ribbon({ tabId:'a', changes:[append 'хвост'] }); outbox.send('status', { tabId:'a', status:'idle' })
  // записанные каналы по порядку: [ribbonChanged, 'status']
})
test('без накопленной ленты статус уходит сразу и один', () => {})
test('лента без статуса уходит по таймеру одним сообщением', () => {})
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/unit/rendererOutbox.test.ts`
Expected: FAIL — модуля нет. (Без него порядок в `index.ts` — статус первым; этот тест и фиксирует обратный.)

- [ ] **Step 3: Реализовать и подключить в `index.ts`**

- [ ] **Step 4: Прогнать тесты**

Run: `npm run typecheck && npx vitest run tests/unit/rendererOutbox.test.ts tests/unit/ribbonBatcher.test.ts && npm run test:e2e -- ribbon formatting`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/rendererOutbox.ts src/main/index.ts tests/unit/rendererOutbox.test.ts
git commit -m "fix: flush the ribbon before status and panel reach the window (B13)"
```

---

### Task 13: B14 — тестовые лазейки только в e2e-сборке

Флаг сборки `__QCLOD_TEST_SEAMS__`: `true` в `electron-vite build --mode e2e`, в `dev` и в vitest; `false` в обычной (`production`) сборке. Каждое чтение лазейки пишется **в месте использования** как `__QCLOD_TEST_SEAMS__ ? process.env['X'] : undefined` — константное условие бандлер выбрасывает вместе со строкой имени, и это проверяется по готовому `out/`.

Лазейки под флагом: `QCLOD_FAKE_SDK`, `QCLOD_FAKE_SDK_SCRIPT`, `QCLOD_FAKE_HISTORY`, `QCLOD_PICK_FOLDER`, `QCLOD_PICK_FILES`, `QCLOD_CONFIRM_BYPASS` (вместо нынешнего `!app.isPackaged`). `QCLOD_USER_DATA` и `QCLOD_HEADLESS` остаются: они не обходят ни одной проверки и не подменяют агента, а `packaged.spec.ts` и ручной смоук ими пользуются.

**Files:**
- Create: `src/main/buildFlags.d.ts`, `scripts/check-release-seams.mjs`
- Modify: `electron.vite.config.ts`, `vitest.config.ts`, `package.json` (scripts), `src/main/agent/createDriver.ts`, `src/main/index.ts:35-36,135-136`, `src/main/agentIpc.ts:169,179`, `tests/e2e/packaged.spec.ts` (комментарий о том, какую сборку запускать)
- Test: `scripts/check-release-seams.mjs` (проверка готовой сборки), `tests/unit/createDriver.test.ts`

**Interfaces:**
- Produces:
  - `declare const __QCLOD_TEST_SEAMS__: boolean` в `src/main/buildFlags.d.ts`.
  - `electron.vite.config.ts` — функция `({ mode }) => ({ … })`, в `main` и `preload`: `define: { __QCLOD_TEST_SEAMS__: JSON.stringify(mode !== 'production') }`.
  - `vitest.config.ts`: `define: { __QCLOD_TEST_SEAMS__: 'true' }`.
  - Скрипты: `"build:e2e": "electron-vite build --mode e2e"`, `"test:e2e": "npm run build:e2e && playwright test"`, `"check:seams": "node scripts/check-release-seams.mjs"`, `"dist": "npm run icon && npm run build && npm run check:seams && electron-builder --win --x64"`, `"dist:e2e": "npm run icon && npm run build:e2e && electron-builder --win dir --x64 -c.directories.output=dist-e2e"`.
  - `check-release-seams.mjs`: обходит `out/main/**/*.js`, ищет `/QCLOD_(FAKE_SDK|FAKE_HISTORY|PICK_FOLDER|PICK_FILES|CONFIRM_BYPASS)/`; нашёл — печатает файл и имя, выходит с кодом 1; не нашёл — «лазеек нет», код 0.

- [ ] **Step 1: Падающая проверка**

Run: `npm run build && node scripts/check-release-seams.mjs`
Expected: FAIL (код 1) — имена `QCLOD_FAKE_SDK`, `QCLOD_PICK_FOLDER` и др. есть в `out/main/index.js`.

(Скрипт пишется первым шагом — это и есть тест бага.)

- [ ] **Step 2: Ввести флаг и закрыть им все лазейки**

- [ ] **Step 3: Релизная сборка чистая**

Run: `npm run build && npm run check:seams`
Expected: PASS, «лазеек нет».

Если имя всё же осталось — значит, чтение лазейки ушло во вспомогательную функцию и бандлер не выбросил его; вернуть условие в место использования.

- [ ] **Step 4: e2e-сборка с лазейками и юнит-тесты**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e`
Expected: PASS — e2e по-прежнему ходит в фейк, `createDriver.test.ts` зелёный под vitest-флагом.

- [ ] **Step 5: Коммит**

```bash
git add electron.vite.config.ts vitest.config.ts package.json scripts/check-release-seams.mjs src/main tests
git commit -m "fix: test seams exist only in the e2e build, checked on every dist (B14)"
```

---

### Task 14: Полная проверка и чек-лист установки

**Files:**
- Modify: `docs/superpowers/checklists/release-smoke.md`

**Interfaces:**
- Consumes: всё выше; скрипты `build:e2e`, `dist`, `dist:e2e`, `check:seams` (Task 13).

- [ ] **Step 1: Полный прогон**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e`
Expected: 0 ошибок типов; все юнит-тесты PASS и **нет** «Unhandled Errors»; все e2e PASS.

- [ ] **Step 2: Релизная и e2e-упаковка**

Run: `npm run dist && npm run dist:e2e`, затем `QCLOD_PACKAGED_EXE=dist-e2e/win-unpacked/Qclod.exe npx playwright test packaged`
Expected: `dist` собирается и проходит `check:seams`; `packaged.spec.ts` PASS против e2e-упаковки.

- [ ] **Step 3: Обновить `release-smoke.md`**

- Блок команд в начале: `npm run dist` (с проверкой лазеек), `npm run dist:e2e`, путь `dist-e2e/win-unpacked/Qclod.exe` для `packaged`.
- «Вопрос агента»: ответ уходит агенту как ответ на вопрос (ход продолжается), а не отдельным сообщением.
- Раздел «Установка и первый запуск на чужой машине» переписать под winget:
  - «Машина без Claude Code» — экран установки, кнопка «Установить»; Node.js не требуется.
  - «Кнопка „Установить“» ставит через `winget install --id Anthropic.ClaudeCode`, вывод виден в окне, по завершении проверка проходит сама.
  - «Машина без winget, но с Node.js» — запасной путь `npm install -g @anthropic-ai/claude-code`; после него Qclod запускает `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, а не `claude.cmd` (B2).
  - «Машина без winget и без Node.js» — понятный текст, а не тишина.
  - «Отмена установки» — в диспетчере задач не остаётся `winget.exe`/`npm`/`node.exe` установщика; повторное «Установить» до конца отмены не стартует (B6).
  - «Новая вкладка» в установленном приложении открывается в домашней папке, а не в папке установки (B7).
  - «Лазейки закрыты» — `dist/win-unpacked/Qclod.exe`, запущенный с `QCLOD_FAKE_SDK=<путь к фикстуре>`, всё равно работает с настоящим агентом (или показывает экран установки), а не с фейком (B14).
  - «Закрытие приложения» во время работы агента завершается за несколько секунд, процесса `claude.exe` после выхода нет (B8).
- Раздел «Правая панель» (P1–P8), на настоящем агенте:
  - Новая вкладка: до первого сообщения видны контекст, модель, лимиты 5 ч / 7 дн.
  - Открыть старую сессию с подагентами и сжатием: видны история до сжатия, сворачиваемая сводка сжатия, подагенты с итогами; ни одного пузыря `<task-notification>` или «This session is being continued…».
  - Запустить фоновый подагент: карточка «работает», растут токены и число инструментов, по уведомлению — «готов»; упавший подагент остаётся в списке с «ошибка».
  - Закрыть приложение, пока фоновый подагент работает, открыть снова: карточка «не закончил».
  - Перезапуск с двумя вкладками: фоновая без клика показывает ленту и подагентов, процесса `claude.exe` у неё нет до перехода.
  - После resume строка стоимости подписана «с момента открытия».
  - Лимиты совпадают с `/usage` в терминале (проверка перевода 0–100 → 0–1).
  - Убрать строки про «Кнопка „Скачать“ открывает nodejs.org» и «вывод npm» как основной путь — их больше нет.

- [ ] **Step 4: Коммит**

```bash
git add docs/superpowers/checklists/release-smoke.md
git commit -m "docs: release smoke checklist for winget install and stage 1 fixes"
```

---

## Решения, принятые в плане (на просмотр владельцу)

- **Ответ на `AskUserQuestion` через `updatedInput.answers`** (Task 2), а не отказом плюс отдельным сообщением. Основание — поле `answers` в `AskUserQuestionInput` из `sdk-tools.d.ts`. Настоящим агентом не проверено: автотесты ходят только в фейк. Проверка — пункт «Вопрос агента» в `release-smoke.md`. Если настоящий CLI это поле не примет, запасной путь (сообщение) уже есть в коде, вернуться к нему — одна строка.
- **Фейковый `askPermission` не меняет порядок** «разрешение → инструмент». Настоящий CLI сначала показывает `tool_use`, но смена порядка меняет вид ленты, а это этап 2.
- **Карточки отменённых запросов** помечаются существующими состояниями `denied` / `rejected`, нового состояния «отменено» не вводится — это тоже вид ленты, этап 2.
- **Фейк «молчит» только без `steps`** (Task 2a). Сценарий с непустыми `steps` по-прежнему играет их сразу — как ход, отправленный до старта; `init` и `rate_limit_event` идут в начале этого хода. Строгий вариант (`steps` — ответ на первый `send`) требует переписать около сотни тестов на «сначала отправь сообщение» — это этап 2. Тесты, которые держались на `init` до сообщения, помечаются `test.fails` и снимаются задачами 2e/2f, а не подгоняются.
- **Шаги подагентов читаются из их JSONL-файлов, а не через `getSubagentMessages`** (Task 2d): функция в SDK есть, но отдаёт урезанные сообщения и под фейком не грузится. Один путь чтения проверяет e2e.
- **`background_tasks_changed` ничего не меняет в карточках** (Task 2c): SDK не обещает порядок относительно `task_notification`; карточку закрывает только уведомление или `task_updated`.
- **Карточка подагента, работавшая при закрытии приложения, — новое состояние `unfinished` («не закончил»)** (Tasks 2b, 2d), а не `done` с подписью: иначе панель пишет «готов» про то, что не закончилось.
- **Оценка контекста фоновой вкладки** (Task 2g) — по `usage` последнего ответа в записи, окно 200k или 1M по суффиксу `[1m]`; помечена «по записи» и заменяется настоящим ответом процесса после перехода. Настоящим агентом не сверено.
- **Усилие хранится в `tabs.json` вкладки** (Task 2e): раньше оно нигде не хранилось, а показывать «из сохранённой настройки вкладки» без хранения нечего.
- **Лимиты через `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`** (Task 2e) — с проверкой наличия метода и тихим откатом на `rate_limit_event`. Имя метода SDK обещает поменять; при обновлении SDK проверить.
- **`QCLOD_USER_DATA` и `QCLOD_HEADLESS` остаются** в релизной сборке: они не обходят проверок и не подменяют агента.
