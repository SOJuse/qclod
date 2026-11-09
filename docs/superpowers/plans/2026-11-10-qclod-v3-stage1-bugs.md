# Qclod v3 — Этап 1: баги. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть баги B1–B14 из аудита: ничего не виснет и не теряется, проверка типов чистая, юнит-тесты без unhandled rejection, тестовые лазейки есть только в сборке для e2e.

**Architecture:** Ядро v2 не меняется: SDK в главном процессе, `AgentSession` на вкладку, `PermissionBroker` между агентом и человеком. Чинится то, что лежит на стыках: какие поля SDK мы читаем (`toolUseID`, `signal`), как сессия считает ожидающие вопросы и отменяет их, как вкладка узнаёт о мёртвой сессии, какой файл запускается, в каком порядке события уходят в окно. Тестовые лазейки прячутся за флагом сборки `__QCLOD_TEST_SEAMS__`, который в релизной сборке равен `false` и вырезается бандлером.

**Tech Stack:** Electron 33, electron-vite 2, React 18, TypeScript 5, zustand 5, `@anthropic-ai/claude-agent-sdk` 0.3.319, Vitest 2, Playwright (`_electron`), electron-builder 25.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md` — раздел 4 «Этап 1 — баги» и решение раздела 7 о лазейках B14.

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
- Сообщения коммитов короткие, без служебных подписей.
- Ветка — `feat/qclod-v2`. Команды проверки: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`.

## Сверка с кодом

Каждый баг перепроверен по коду ветки `feat/qclod-v2` (коммит `354bfe4`). Все четырнадцать настоящие; **отброшенных нет**. Уточнения к номерам строк аудита:

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

Требование раздела 9 спеки («агент стартует у вкладки при первом переходе, запущенная вкладка работает в фоне») сверено: `TabController.restore` поднимает только активную (`:104`), `activate` — по переходу (`:153`), переключение сессий не останавливает. Код ведёт себя так, правка не нужна.

## Review Focus

Пять случаев, которые спека подразумевает, но тесты отдельных багов сами бы не поймали. Тест на каждый добавлен в задачу, которой принадлежит код.

1. **Путь npm с пробелом и кириллицей.** `C:\Users\Иван Петров\AppData\Roaming\npm\claude.cmd` — разворачивается в настоящий `claude.exe` и запускается. → Задача 5.
2. **Свой префикс npm.** `npm config set prefix D:\tools\npm`: обёртка лежит не в `%APPDATA%\npm`, а где-то в PATH — всё равно находится настоящий exe, а не `.cmd`. → Задача 5.
3. **Стоп в одной вкладке, пока вторая ждёт разрешения.** Ожидающий запрос соседней вкладки не отменяется и отвечается как обычно. → Задача 3.
4. **Клик по варианту вопроса уже после «Стоп».** Не возвращает «работает» навсегда: выбор уходит обычным сообщением, ход заканчивается `idle`. → Задача 3.
5. **«Отмена», затем сразу «Установить».** Вторая установка не стартует, пока первая не умерла целиком; после её смерти — стартует. → Задача 6.

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
- Modify: `src/main/tabs/TabController.ts:173-179,237-274`, `src/main/agent/AgentSession.ts` (`onStatus` возвращает отписку)
- Test: `tests/unit/tabController.test.ts`

**Interfaces:**
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
- Produces: `private background(work: Promise<unknown>): void` — вешает `.catch(() => undefined)`. Все `void this.refreshX()` в `AgentSession` идут через него. (`TabController` переведён на `track()` в Task 4.)

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
- Test: `tests/unit/appStore.test.ts` (новый; zustand работает в node без DOM)

**Interfaces:**
- Produces: `setTabs(tabs)` удаляет из `ribbonByTab`, `todoByTab`, `panelByTab`, `draftByTab`, `attachmentsByTab`, `fileIndexByTab` ключи вкладок, которые были в прежнем `state.tabs` и пропали из нового. Ключи вкладок, которых стор ещё не видел в `tabs`, не трогаются: события ленты новой вкладки могут прийти раньше списка, полученного по `tabsList`.

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
- **`QCLOD_USER_DATA` и `QCLOD_HEADLESS` остаются** в релизной сборке: они не обходят проверок и не подменяют агента.
