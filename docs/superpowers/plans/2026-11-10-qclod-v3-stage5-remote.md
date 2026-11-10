# Qclod v3 — Этап 5: Remote Control на вкладке. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопкой на вкладке (и командой `/remote-control`) включить Remote Control для сессии этой вкладки: сессию можно продолжать с телефона или claude.ai, в панели видны ссылка, QR-код и «Выключить», на вкладке — значок состояния; сообщения с телефона и ответы на разрешения оттуда честно отражаются в ленте.

**Architecture:** Главный процесс зовёт недокументированный `query.enableRemoteControl(enabled, name)` через `AgentDriver.setRemoteControl`, предварительно проверив его наличие и `initializationResult()`. Состояние моста (`RemoteInfo`) живёт в `AgentSession`, обновляется ответом на включение и системными сообщениями `bridge_state` / `worker_shutting_down`, и доходит до окна полем `TabState.remote` по уже существующему каналу `tabs:changed`. Разбор сообщений, тексты и правила доступности — чистые функции в `src/shared/remote.ts`; QR рисуется локально из матрицы `uqr` в один SVG-`path`.

**Tech Stack:** Electron 33, React 18, TypeScript 5, zustand 5, `@anthropic-ai/claude-agent-sdk` **0.3.319 (точная версия)**, `uqr` **0.1.3** (новая зависимость, точная), `lucide-react` 1.62.0, Vitest 2, Playwright (`_electron`) против `tests/fixtures/fake-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md`, раздел 8 (Этап 5 — Remote Control) и ограничения раздела 9.

## Global Constraints

- Платформа — только Windows 11 x64.
- **Ни одна задача не запускает приложение с настоящим агентом, настоящий `claude` и настоящий Remote Control** (он создаёт настоящую сессию на claude.ai). Все автотесты — против `tests/fixtures/fake-sdk`; e2e — только с `QCLOD_FAKE_SDK` (его ставит `playwright.config.ts`). Живую проверку с телефоном делает владелец.
- Каждая задача начинается с падающего теста; шаг «прогнать и убедиться, что падает» не пропускается.
- Фейк расширяется там, где задаче нужно новое поведение; в `tests/fixtures/fake-sdk/README.md` — строка о каждом новом шаге и поле сценария. Формы сообщений фейка — ровно те, что в «Сверке» ниже.
- Метод внутренний: доступ только через проверку `typeof q.enableRemoteControl === 'function'`; версия SDK закреплена `"@anthropic-ai/claude-agent-sdk": "0.3.319"` без `^`.
- Нужен вход через подписку claude.ai (Pro/Max/Team/Enterprise); с API-ключом не работает — говорим это человеческим текстом (тексты в Task 1, менять их можно только вместе с тестом).
- Весь текст для пользователя — по-русски, просто, без воды, в тоне остального приложения. Название функции пишется как в Claude Code: «Remote Control».
- CSS — только через `var(--…)` из `src/renderer/styles/tokens.css`; новый токен добавляется туда же в той же задаче. Этап 3 может менять значения токенов параллельно — компоненты на это не рассчитывают.
- Иконки — только `lucide-react@1.62.0`.
- Qclod не трогает учётные данные и файлы настроек пользователя/проекта. `TabState.remote` **не** пишется в `tabs.json`.
- Ссылка показывается и открывается, только если это `https://`; открывается существующим `window.qclod.openExternal`.
- В сообщениях коммитов **нет** подписей соавторов и упоминаний Claude/ИИ. Стиль истории: `feat: …`, `fix: …`.
- Этап 2 (последние задачи) и этап 3 (вид) могут менять те же файлы одновременно: `AgentSession.ts`, `ribbon.ts`, `TabController.ts`, `StatusLine.tsx`, `SidePanel.tsx`, `TabStrip.tsx`, `RibbonItem.tsx`, `PermissionCard.tsx`, `PlanCard.tsx`, `QuestionCard.tsx`, `ChatPane.tsx`, `App.tsx`, `tokens.css`. **Перед каждой правкой — перечитать файл** (`git log -3 -- <файл>`) и встраиваться в свежий код по именам компонентов и методов; номера строк в плане не приводятся сознательно.
- Ветка — `feat/qclod-v2`. Проверки: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`; один файл e2e — `npm run build:e2e && npx playwright test tests/e2e/<file>.spec.ts`.
- Порядок: Task 1–11 по номерам.

## Сверка с SDK и CLI (проверено 2026-11-10)

| Что | Где | Вывод |
|---|---|---|
| `enableRemoteControl(e, t, n)` | `sdk.mjs` 0.3.319, класс Query; в `sdk.d.ts` **нет** | Шлёт `{subtype:'remote_control', enabled, name?, reattach_session_id, keep_session_on_exit, work_secret}` и возвращает `response`. Зовём `(q as RemoteCapable).enableRemoteControl(enabled, name)` без третьего аргумента |
| Ответ на включение | CLI 2.1.317 (бинарник пользователя) | `{session_url, connect_url, environment_id, bridge_epoch, bridge_session_id}`. Показываем и кодируем в QR `session_url` |
| Отказы CLI | там же | Например `"Remote Control cannot be enabled from inside a remote session"`; без подписки — ошибка входа. Ошибка приходит как reject промиса |
| Доступность | `initializationResult(): Promise<SDKControlInitializeResponse>` (в типах); поле `remote_control_available` CLI кладёт в ответ initialize, но **в `sdk.d.ts` его нет** | Читаем как `unknown`; `false` → недоступно; нет поля (старый CLI) → считаем доступным и полагаемся на ошибку включения |
| Вход | `AccountInfo {subscriptionType?, apiKeySource?, apiProvider?}` (`sdk.d.ts`) | `apiProvider` есть и не `'firstParty'` → «не подписка»; `apiKeySource` есть, а `subscriptionType` нет → «API-ключ» |
| Статус моста | CLI: `{type:'system', subtype:'bridge_state', state, detail, failure_kind? (только при state 'failed', по умолчанию 'terminal'), bridge_epoch, uuid, session_id}` | Видели состояния `ready`, `connected`, `reconnecting`, `failed`, `policy_disabled`. В `SDKMessage` этого типа нет — читаем как `unknown` |
| Выключение | `SDKWorkerShuttingDownMessage {type:'system', subtype:'worker_shutting_down', reason}` (в типах) | `reason === 'remote_control_disabled'` → состояние `off` |
| Ответ на разрешение с телефона | `handleControlCancelRequest` в `sdk.mjs`: CLI шлёт `control_cancel_request`, SDK абортит `signal`, переданный в `canUseTool` | Аборт сигнала SDK при живом мосте = «ответили в другом месте». Каким был ответ, SDK не сообщает |
| Сообщения с телефона | `SDKUserMessage` (`origin?: SDKMessageOrigin`) | Приходят в поток как `user`, которых Qclod не отправлял (нет в `pendingEchoes`). На `origin` не полагаемся — его наличие не подтверждено |

## Решения по виду (frontend-design)

Этап 3 задаёт палитру и шрифты; здесь — только структура и роли токенов.

- **Цвета (роли, не значения):** `--ok` — мост на связи; `--warn` — подключается/переподключается; `--danger` — не работает; `--text-faint` — выключено. Новый токен `--qr-paper` (светлый, почти белый лист под QR — сканеры телефонов плохо читают светлое на тёмном) и `--qr-ink` (почти чёрный). Цвет никогда не единственный носитель смысла: рядом всегда слово состояния.
- **Шрифт:** текущий текстовый; ссылка — `--font-mono`, перенос по символам (`overflow-wrap: anywhere`), выделяется мышью.
- **Одна запоминающаяся деталь — QR на «листке»:** квадрат 168 px на `--qr-paper` со скруглением `--radius-sm`, без тени и рамки-подсветки. Всё вокруг тихое.
- **Раскладка секции панели** (секция идёт первой, пока мост не выключен; выключенный — компактная строка в конце панели):

```
┌ Remote Control ─────────────────────┐
│ ● на связи                          │   точка + слово состояния
│ ┌──────────┐                        │
│ │  ▓▓ QR ▓ │  Наведите камеру       │   QR слева, подсказка справа
│ │  ▓▓▓  ▓▓ │  телефона или откройте │   (на узкой панели — подсказка под QR)
│ └──────────┘  ссылку на claude.ai.  │
│ https://claude.ai/code/session_…    │   моно, переносится, выделяется
│ [Открыть в браузере]  [Выключить]   │
│ Закроете вкладку — сессия на        │   panel-note, тихим цветом
│ телефоне станет недоступна.         │
└─────────────────────────────────────┘
```

- **Строка состояния:** кнопка-переключатель с `Smartphone`. Выключено — только значок с подсказкой; включено — значок цвета состояния и слово («на связи», «подключается…», «нет связи»).
- **Вкладка:** маленький `Smartphone` (11 px) после названия, цвет по состоянию; в `title` вкладки — третья строка «Remote Control: на связи». Это отдельный значок, а не вторая точка: точка статуса сессии уже есть, две точки рядом читаются как одна.
- **Пузырь с телефона:** тот же пузырь человека, над текстом строка `Smartphone` 12 px + «с телефона» тихим цветом; подсказка «Написано через Remote Control — с телефона или claude.ai».
- **Карточка, на которую ответили с телефона:** закрывается так же, как отвеченная, с итогом «ответили с телефона или claude.ai».

## Review Focus

1. **Двойной клик / `/remote-control` во время подключения** — второе включение не уходит в CLI, пока первое не ответило; выключение во время подключения выполняется после ответа. Тест — Task 6 (`повторное включение во время подключения не шлёт второй запрос`).
2. **Перезапуск или восстановление вкладки при включённом мосте** — новая сессия начинает с `off`, значок на вкладке гаснет, в ленте заметка «Remote Control выключен: сессия перезапущена. Включите снова, если нужно». Тест — Task 7.
3. **Сообщение с телефона во время хода, начатого в Qclod** — пузырь появляется, статус остаётся «работает», ход не считается дважды, и «Стоп» по-прежнему отменяет ожидающие вопросы. Тест — Task 6 (`сообщение с телефона во время хода не открывает второй ход`).
4. **Клик в Qclod по карточке, на которую уже ответили с телефона** — ничего не отправляет и не сохраняет правило. Тест — Task 6 (`поздний ответ из Qclod после ответа с телефона игнорируется`).
5. **CLI сам роняет мост** (`bridge_state failed`, `policy_disabled`, `worker_shutting_down`) — значок становится красным или гаснет, в панели причина простыми словами, кнопка снова может включить. Тесты — Task 1 (разбор), Task 6 (сессия), Task 10 (e2e).

---

### Task 1: Общая модель Remote Control и тексты

**Files:**
- Create: `src/shared/remote.ts`
- Modify: `src/shared/types.ts` (типы `RemoteState`, `RemoteBlock`, `RemoteInfo`; поле `TabState.remote?`)
- Test: `tests/unit/remote.test.ts`

**Interfaces:**
- Produces (в `types.ts`):
  - `type RemoteState = 'off' | 'connecting' | 'on' | 'reconnecting' | 'failed'`
  - `type RemoteBlock = 'sdk' | 'cli' | 'api_key' | 'provider'`
  - `interface RemoteInfo { state: RemoteState; url?: string; problem?: string; blocked?: RemoteBlock }`
  - `TabState.remote?: RemoteInfo`
- Produces (в `remote.ts`):
  - `REMOTE_OFF: RemoteInfo` = `{ state: 'off' }`
  - `REMOTE_STATE_LABEL: Record<RemoteState, string>`
  - `REMOTE_BLOCK_TEXT: Record<RemoteBlock, string>`
  - `isRemoteLive(info: RemoteInfo | undefined): boolean` — `state` не `off` и не `failed`
  - `safeRemoteUrl(value: unknown): string | null` — строка, `new URL` разбирает, протокол `https:`
  - `availabilityFrom(hasMethod: boolean, init: unknown): RemoteAvailability`, где `type RemoteAvailability = { available: true } | { available: false; reason: RemoteBlock }`
  - `remoteFromMessage(message: unknown, current: RemoteInfo): RemoteInfo | null` — `null`, если сообщение не о мосте или ничего не меняет
  - `explainRemoteError(err: unknown): string`

Тексты (точно так):

| Ключ | Текст |
|---|---|
| `REMOTE_STATE_LABEL.off` | `выключен` |
| `.connecting` | `подключается…` |
| `.on` | `на связи` |
| `.reconnecting` | `переподключается…` |
| `.failed` | `нет связи` |
| `REMOTE_BLOCK_TEXT.sdk` | `Эта версия Qclod не умеет включать Remote Control. Обновите Qclod.` |
| `.cli` | `Ваш Claude Code не предлагает Remote Control. Обновите его командой claude update; если не поможет — возможно, Remote Control отключён в вашей организации.` |
| `.api_key` | `Remote Control работает только при входе через подписку claude.ai (Pro, Max, Team или Enterprise). Сейчас Claude Code вошёл по API-ключу. Войдите через claude.ai командой /login и перезапустите вкладку.` |
| `.provider` | `Remote Control работает только с подпиской claude.ai, а этот Claude Code подключён через Bedrock, Vertex или другой сервис.` |
| bridge `failed` | `Связь с claude.ai потеряна.` + (`detail` ? ` ${detail}` : '') |
| bridge `policy_disabled` | `Remote Control отключён политикой вашей организации.` |
| ошибка входа (см. ниже) | `REMOTE_BLOCK_TEXT.api_key` |
| прочая ошибка | `Не удалось включить Remote Control: ${message}` |

Правила `remoteFromMessage` (тип `system`):
- `subtype 'bridge_state'`: `ready`/`connected` → `{...current, state:'on', problem: undefined}`; `reconnecting` → `state:'reconnecting'`; `failed` → `state:'failed', problem: текст failed`; `policy_disabled` → `state:'failed', problem: текст policy`; неизвестное состояние → `null`. Сообщение о мосте, пока `current.state === 'off'`, → `null` (поздний хвост после выключения не включает значок обратно).
- `subtype 'worker_shutting_down'` с `reason 'remote_control_disabled'` → `{ state: 'off' }` (url сбрасывается); другая причина → `null`.

`explainRemoteError`: `/api.?key|subscription|claude\.ai account|log ?in|oauth|not logged/i` → текст `api_key`; иначе «Не удалось включить…» с `err.message` (или `String(err)`).

`availabilityFrom`: `!hasMethod` → `sdk`; `init.remote_control_available === false` → `cli`; `init.account.apiProvider` есть и `!== 'firstParty'` → `provider`; `init.account.apiKeySource` есть и `subscriptionType` нет → `api_key`; иначе `{available:true}` (в том числе когда `init` не объект).

- [ ] **Step 1: Write the failing tests** — `tests/unit/remote.test.ts`:

```ts
describe('remoteFromMessage', () => {
  const on: RemoteInfo = { state: 'on', url: 'https://claude.ai/code/session_1' }
  test('connected и ready — на связи, ссылка сохраняется', () => {
    expect(remoteFromMessage(bridge('connected'), { state: 'connecting' })).toMatchObject({ state: 'on' })
    expect(remoteFromMessage(bridge('ready'), on)).toBeNull() // ничего не меняет
  })
  test('failed — нет связи, причина с подробностью', () => {
    expect(remoteFromMessage(bridge('failed', 'таймаут'), on)).toEqual({
      ...on, state: 'failed', problem: 'Связь с claude.ai потеряна. таймаут'
    })
  })
  test('policy_disabled — причина про организацию', () => {
    expect(remoteFromMessage(bridge('policy_disabled'), on)?.problem).toBe(
      'Remote Control отключён политикой вашей организации.'
    )
  })
  test('worker_shutting_down remote_control_disabled — выключен', () => {
    expect(remoteFromMessage({ type: 'system', subtype: 'worker_shutting_down', reason: 'remote_control_disabled' }, on))
      .toEqual({ state: 'off' })
    expect(remoteFromMessage({ type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }, on)).toBeNull()
  })
  test('хвост моста после выключения не включает обратно', () => {
    expect(remoteFromMessage(bridge('connected'), { state: 'off' })).toBeNull()
  })
  test('неизвестное состояние и чужие сообщения — null', () => {
    expect(remoteFromMessage(bridge('warming'), on)).toBeNull()
    expect(remoteFromMessage({ type: 'assistant' }, on)).toBeNull()
  })
})
describe('availabilityFrom', () => {
  test('нет метода → sdk', () => expect(availabilityFrom(false, {})).toEqual({ available: false, reason: 'sdk' }))
  test('CLI сказал false → cli', () =>
    expect(availabilityFrom(true, { remote_control_available: false })).toEqual({ available: false, reason: 'cli' }))
  test('API-ключ без подписки → api_key', () =>
    expect(availabilityFrom(true, { account: { apiKeySource: 'ANTHROPIC_API_KEY' } })).toEqual({ available: false, reason: 'api_key' }))
  test('Bedrock → provider', () =>
    expect(availabilityFrom(true, { account: { apiProvider: 'bedrock' } })).toEqual({ available: false, reason: 'provider' }))
  test('подписка или старый CLI без поля → доступно', () => {
    expect(availabilityFrom(true, { account: { subscriptionType: 'max' }, remote_control_available: true })).toEqual({ available: true })
    expect(availabilityFrom(true, undefined)).toEqual({ available: true })
  })
})
describe('safeRemoteUrl и explainRemoteError', () => {
  test('только https', () => {
    expect(safeRemoteUrl('https://claude.ai/code/session_1')).toBe('https://claude.ai/code/session_1')
    expect(safeRemoteUrl('http://claude.ai/x')).toBeNull()
    expect(safeRemoteUrl('javascript:alert(1)')).toBeNull()
    expect(safeRemoteUrl(42)).toBeNull()
  })
  test('ошибка входа — про подписку простыми словами', () => {
    expect(explainRemoteError(new Error('Remote Control requires a claude.ai subscription'))).toBe(REMOTE_BLOCK_TEXT.api_key)
    expect(explainRemoteError(new Error('boom'))).toBe('Не удалось включить Remote Control: boom')
  })
})
```

`bridge(state, detail?)` — локальный помощник теста, собирает сообщение в форме из «Сверки».

- [ ] **Step 2: Run** `npx vitest run tests/unit/remote.test.ts` — Expected: FAIL, модуль не найден.
- [ ] **Step 3: Implement** `src/shared/remote.ts` и типы в `types.ts` по Interfaces и таблицам выше. Сообщения разбираются как `unknown` с проверками полей, без импорта типов SDK (модуль общий для окна).
- [ ] **Step 4: Run** `npx vitest run tests/unit/remote.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/shared/remote.ts src/shared/types.ts tests/unit/remote.test.ts
git commit -m "feat: remote control state, bridge messages and plain-language reasons"
```

---

### Task 2: Закрепить SDK и сторожить внутренний метод

**Files:**
- Modify: `package.json` (`"@anthropic-ai/claude-agent-sdk": "0.3.319"`), `package-lock.json`
- Test: `tests/unit/sdkPin.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/sdkPin.test.ts`:

```ts
test('версия SDK закреплена точно', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.319')
})
test('в установленном SDK есть enableRemoteControl — иначе Remote Control молча пропадёт', () => {
  const sdk = readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'utf8')
  expect(sdk).toContain('enableRemoteControl(')
  expect(sdk).toContain('subtype:"remote_control"')
  const installed = JSON.parse(readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'))
  expect(installed.version).toBe('0.3.319')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/sdkPin.test.ts` — Expected: FAIL на первом тесте (`^0.3.319`).
- [ ] **Step 3:** Заменить `^0.3.319` на `0.3.319`, выполнить `npm install --ignore-scripts` (сеть есть; при ошибке «certificate is not yet valid» — это часы ПК, TLS не отключать, сказать владельцу). Убедиться, что lock указывает 0.3.319.
- [ ] **Step 4: Run** `npx vitest run tests/unit/sdkPin.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/unit/sdkPin.test.ts
git commit -m "chore: pin the agent SDK and guard the remote control method"
```

---

### Task 3: Фейковый SDK умеет Remote Control

**Files:**
- Modify: `tests/fixtures/fake-sdk/index.mjs`, `tests/fixtures/fake-sdk/index.d.mts`, `tests/fixtures/fake-sdk/README.md`
- Test: `tests/unit/fakeSdk.test.ts` (новый `describe('createFakeSdk: Remote Control')`)

**Interfaces:**
- Produces (методы фейка — те же, что Task 4 добавит в `AgentDriver`):
  - `remoteAvailability(): Promise<RemoteAvailability>`
  - `setRemoteControl(enabled: boolean, name?: string): Promise<{ sessionUrl: string; connectUrl?: string } | null>`
  - `typeOnPhone(text: string, steps?: Step[]): void` — только фейк; ход «с телефона»
  - геттер `remoteCalls: Array<{ enabled: boolean; name?: string }>`
- Поле сценария `remoteControl?: { blocked?: RemoteBlock; enableError?: string; sessionUrl?: string; bridge?: Array<{ state: string; detail?: string; failure_kind?: string; afterMs?: number }>; phoneTurns?: Array<{ text: string; afterMs?: number; steps?: Step[] }> }`
- Новый шаг `remoteAnswer { name, input?, decision: 'allow' | 'deny', afterMs? }`

Поведение:
- **Сообщения вне хода.** Новая очередь `outbox`: сообщения, которые CLI шлёт сам (мост, ход с телефона). Цикл `stream()` будится и `send`, и `outbox`; между ходами выдаёт всё из `outbox`.
- `remoteAvailability()` → `blocked` ? `{available:false, reason: blocked}` : `{available:true}`.
- `setRemoteControl(true, name)` — пишет в `remoteCalls`; `enableError` → reject `new Error(enableError)`; иначе отвечает формой CLI, переведённой как в настоящем драйвере (`{sessionUrl, connectUrl}`, по умолчанию `https://claude.ai/code/session_fake0001` и `https://claude.ai/code?environment=env_fake`); затем в `outbox` — `bridge` (по умолчанию `[{state:'connected'}]`) в форме `{type:'system', subtype:'bridge_state', state, detail: detail ?? null, ...(state==='failed' && {failure_kind: failure_kind ?? 'terminal'}), bridge_epoch: 1, uuid, session_id}` с паузами `afterMs`; затем `phoneTurns` через `typeOnPhone` с паузами.
- `setRemoteControl(false)` — пишет в `remoteCalls`, кладёт в `outbox` `{type:'system', subtype:'worker_shutting_down', reason:'remote_control_disabled', uuid, session_id}`, отвечает `null`.
- `typeOnPhone(text, steps)` — кладёт в `inbox` `{ phone: true, text, steps }`. Цикл играет его как ход: `introduce()`, сообщение `user` той же формы, что эхо (`parent_tool_use_id: null`, `content: text`), `play(steps ?? script.nextTurn ?? [])`, `finishTurn()`. В `sent` не попадает — Qclod его не отправлял.
- Шаг `remoteAnswer`: спрашивает `canUseTool` как `askPermission` (с `toolUseID` и своим `signal`), через `afterMs` (по умолчанию 50) абортит именно этот сигнал — так CLI шлёт `control_cancel_request`, когда ответили на телефоне, — и дальше идёт по `decision`: `allow` → выполняет инструмент (`tool`, результат `ok`), `deny` → `permission_denied`. Ответ Qclod, пришедший после аборта, игнорируется.

- [ ] **Step 1: Write the failing tests:**

```ts
describe('createFakeSdk: Remote Control', () => {
  test('включение отвечает ссылкой и шлёт bridge_state connected', async () => {
    const d = createFakeSdk({})
    const link = await d.setRemoteControl(true, 'Qclod — проект')
    expect(link?.sessionUrl).toMatch(/^https:\/\/claude\.ai\//)
    expect(d.remoteCalls).toEqual([{ enabled: true, name: 'Qclod — проект' }])
    const m = await nextMatching(d.messages, (x) => x.subtype === 'bridge_state')
    expect(m).toMatchObject({ type: 'system', state: 'connected', bridge_epoch: 1 })
  })
  test('выключение шлёт worker_shutting_down remote_control_disabled', async () => { /* … reason */ })
  test('blocked и enableError', async () => {
    expect(await createFakeSdk({ remoteControl: { blocked: 'api_key' } }).remoteAvailability())
      .toEqual({ available: false, reason: 'api_key' })
    await expect(createFakeSdk({ remoteControl: { enableError: 'нет подписки' } }).setRemoteControl(true))
      .rejects.toThrow('нет подписки')
  })
  test('ход с телефона: user-сообщение, шаги, result; в sent не попадает', async () => {
    const d = createFakeSdk({})
    d.typeOnPhone('привет с телефона', [{ kind: 'text', text: 'ответ' }])
    const got = await collectUntilResult(d.messages)
    expect(got.find((m) => m.type === 'user')?.message.content).toBe('привет с телефона')
    expect(d.sent).toHaveLength(0)
  })
  test('remoteAnswer: сигнал абортится, инструмент выполняется по decision', async () => {
    const seen: AbortSignal[] = []
    const d = createFakeSdk({
      steps: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'allow' }],
      canUseTool: (_n, _i, o) => { seen.push(o.signal); return new Promise(() => {}) }
    })
    await collectUntilResult(d.messages)
    expect(seen[0]!.aborted).toBe(true)
    expect(d.executedTools).toContain('Bash')
  })
})
```

`nextMatching` и `collectUntilResult` — помощники в этом же файле теста (если похожие уже есть — переиспользовать).

- [ ] **Step 2: Run** `npx vitest run tests/unit/fakeSdk.test.ts` — Expected: FAIL, методов нет.
- [ ] **Step 3: Implement** по описанию выше в `index.mjs`; типы в `index.d.mts`; в `README.md` — строки таблицы шагов для `remoteAnswer`, абзац «Remote Control» про `remoteControl`, `typeOnPhone`, `remoteCalls`, форму `bridge_state`/`worker_shutting_down` и ответ включения (со ссылкой на «Сверку» этого плана как источник форм).
- [ ] **Step 4: Run** `npx vitest run tests/unit/fakeSdk.test.ts` — Expected: PASS (и старые тесты фейка тоже).
- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/fake-sdk tests/unit/fakeSdk.test.ts
git commit -m "test: fake SDK plays remote control, phone turns and remote answers"
```

---

### Task 4: Драйвер: включение, выключение, доступность

**Files:**
- Modify: `src/main/agent/driver.ts`, `src/main/agent/sdkDriver.ts`
- Test: `tests/unit/sdkDriver.test.ts` (новый `describe('sdkDriver: Remote Control')`)

**Interfaces:**
- Consumes: `availabilityFrom`, `safeRemoteUrl`, `RemoteAvailability` (Task 1).
- Produces (в `AgentDriver`):
  - `remoteAvailability(): Promise<RemoteAvailability>`
  - `setRemoteControl(enabled: boolean, name?: string): Promise<RemoteLink | null>`
  - `interface RemoteLink { sessionUrl: string; connectUrl?: string }` (в `driver.ts`)

Реализация в `sdkDriver`:
- `type RemoteCapable = { enableRemoteControl?: (enabled: boolean, name?: string) => Promise<unknown> }`; `session as unknown as RemoteCapable`.
- `remoteAvailability`: `hasMethod = typeof … === 'function'`; `init` = `await Promise.race([session.initializationResult(), timeout 5000 → undefined])`, ошибка → `undefined`; вернуть `availabilityFrom(hasMethod, init)`.
- `setRemoteControl(true, name)`: нет метода → `throw new Error('enableRemoteControl отсутствует')`; ответ без `safeRemoteUrl(session_url)` → `throw new Error('CLI не вернул ссылку на сессию')`; иначе `{ sessionUrl, connectUrl? }` (connectUrl — только если тоже https).
- `setRemoteControl(false)`: зовёт метод с `false`, возвращает `null`; нет метода → `null`.

- [ ] **Step 1: Write the failing tests** (через существующий `mockQuery(methods)`):

```ts
describe('sdkDriver: Remote Control', () => {
  test('нет метода — недоступно по причине sdk', async () => {
    mockQuery({ initializationResult: async () => ({}) })
    const d = await createSdkDriver(driverOptions(allow))
    expect(await d.remoteAvailability()).toEqual({ available: false, reason: 'sdk' })
  })
  test('API-ключ — недоступно по причине api_key', async () => { /* account.apiKeySource */ })
  test('включение передаёт имя и возвращает ссылку', async () => {
    const enable = vi.fn(async () => ({ session_url: 'https://claude.ai/code/session_1', connect_url: 'https://claude.ai/code?environment=e', bridge_session_id: 'b' }))
    mockQuery({ enableRemoteControl: enable })
    const d = await createSdkDriver(driverOptions(allow))
    expect(await d.setRemoteControl(true, 'Qclod — проект')).toEqual({
      sessionUrl: 'https://claude.ai/code/session_1', connectUrl: 'https://claude.ai/code?environment=e'
    })
    expect(enable).toHaveBeenCalledWith(true, 'Qclod — проект')
  })
  test('ответ без https-ссылки — ошибка, а не пустая панель', async () => { /* session_url: 'http://x' → rejects */ })
  test('выключение зовёт метод с false', async () => { /* enable called with (false, undefined); result null */ })
  test('initializationResult не ответил за 5 с — считаем доступным', async () => { /* vi.useFakeTimers; never-resolving promise */ })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/sdkDriver.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** по Interfaces. Методы добавить и в фейк-обёртку `createDriverFactory` не нужно — фейк уже их имеет (Task 3); `npm run typecheck` покажет, если где-то ещё строится `AgentDriver` руками (тесты с `as unknown as AgentDriver` не в счёт).
- [ ] **Step 4: Run** `npx vitest run tests/unit/sdkDriver.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/agent/driver.ts src/main/agent/sdkDriver.ts tests/unit/sdkDriver.test.ts
git commit -m "feat: driver turns remote control on and off when the SDK has it"
```

---

### Task 5: Лента — пузыри с телефона и ответы «в другом месте»

**Files:**
- Modify: `src/shared/ribbon.ts` (`RibbonBuilder`), `src/shared/types.ts` (`RibbonItem`)
- Test: `tests/unit/ribbon.test.ts`

**Interfaces:**
- Produces:
  - `RibbonItem` `user`: `remote?: true`
  - `permission.state`: `'pending' | 'allowed' | 'denied' | 'elsewhere'`
  - `plan.state`: `'pending' | 'approved' | 'rejected' | 'elsewhere'`
  - `question`: `elsewhere?: true`
  - `RibbonBuilder.setRemote(live: boolean): void`
  - `RibbonBuilder.resolvePermission(requestId, state: 'allowed' | 'denied' | 'elsewhere')`
  - `RibbonBuilder.resolvePlan(requestId, state: 'approved' | 'rejected' | 'elsewhere')`
  - `RibbonBuilder.closeQuestionElsewhere(toolUseId: string): RibbonChange[]`

Правило: пока `setRemote(true)` и builder не в режиме повтора истории, пузырь человека, появившийся из потока (не эхо из `pendingEchoes`, не synthetic/meta/от подагента/task-notification — существующие фильтры `onUser` не меняются), получает `remote: true`. После `setRemote(false)` и в повторе истории — нет.

- [ ] **Step 1: Write the failing tests:**

```ts
describe('RibbonBuilder: Remote Control', () => {
  test('чужое сообщение при живом мосте — пузырь человека с пометкой', () => {
    const b = new RibbonBuilder()
    b.setRemote(true)
    const [c] = b.apply(userMsg('с телефона'))
    expect(c).toMatchObject({ kind: 'append', item: { kind: 'user', text: 'с телефона', remote: true } })
  })
  test('эхо своего сообщения при живом мосте — без пометки и без второго пузыря', () => {
    const b = new RibbonBuilder(); b.setRemote(true)
    b.addUser('моё')
    expect(b.apply(userMsg('моё'))).toEqual([])
  })
  test('без моста и в повторе истории — без пометки', () => {
    const live = new RibbonBuilder()
    expect((live.apply(userMsg('x'))[0] as any).item.remote).toBeUndefined()
    const replay = new RibbonBuilder({ replay: true }); replay.setRemote(true)
    expect((replay.apply(userMsg('x'))[0] as any).item.remote).toBeUndefined()
  })
  test('разрешение, план и вопрос закрываются как отвеченные в другом месте', () => {
    const b = new RibbonBuilder()
    b.addPermission('p1', 'Bash', 'ls')
    expect(b.resolvePermission('p1', 'elsewhere')[0]).toMatchObject({ kind: 'update', patch: { state: 'elsewhere' } })
    b.addPlan('pl1', 'план')
    expect(b.resolvePlan('pl1', 'elsewhere')[0]).toMatchObject({ patch: { state: 'elsewhere' } })
    b.apply(askQuestionToolUse('q1'))
    expect(b.closeQuestionElsewhere('q1')[0]).toMatchObject({ patch: { elsewhere: true } })
  })
})
```

`userMsg`, `askQuestionToolUse` — помощники теста (переиспользовать существующие, если есть).

- [ ] **Step 2: Run** `npx vitest run tests/unit/ribbon.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — перечитать `ribbon.ts`; пометка ставится в `appendUser` по флагу `this.remoteLive && !this.replaying`; `addUser` (своё сообщение) пометку не ставит.
- [ ] **Step 4: Run** `npx vitest run tests/unit/ribbon.test.ts && npm run typecheck` — Expected: PASS. Typecheck покажет компоненты карточек, которые сравнивают `state` — их трогает Task 10, здесь достаточно, чтобы типы сходились.
- [ ] **Step 5: Commit**

```bash
git add src/shared/ribbon.ts src/shared/types.ts tests/unit/ribbon.test.ts
git commit -m "feat: ribbon marks messages typed on the phone and cards answered there"
```

---

### Task 6: `AgentSession` ведёт мост

**Files:**
- Modify: `src/main/agent/AgentSession.ts`
- Test: `tests/unit/agentSession.test.ts` (новый `describe('AgentSession: Remote Control')`)

**Interfaces:**
- Consumes: `AgentDriver.remoteAvailability/setRemoteControl` (Task 4), `remoteFromMessage`, `explainRemoteError`, `isRemoteLive`, `REMOTE_BLOCK_TEXT`, `REMOTE_OFF` (Task 1), `RibbonBuilder.setRemote/resolvePermission/resolvePlan/closeQuestionElsewhere` (Task 5).
- Produces:
  - `get remote(): RemoteInfo`
  - `onRemote(cb: (info: RemoteInfo) => void): () => void`
  - `setRemote(enabled: boolean, name?: string): Promise<void>`

Поведение:
- `start()` → в фоне `remoteAvailability()`; недоступно → `remote = { state: 'off', blocked: reason }`.
- `setRemote(true)`: нет драйвера или `blocked` → ничего; уже `connecting`/живой → ничего (Review Focus 1); иначе `connecting` → `await driver.setRemoteControl(true, name)` → `{ state: 'on', url }`; ошибка → `{ state: 'off', problem: explainRemoteError(err) }` и заметка в ленте `notice(problem, 'error')`.
- `setRemote(false)`: во время `connecting` — дождаться текущего включения, потом выключить; `await driver.setRemoteControl(false)` → `REMOTE_OFF`; ошибка → состояние не меняется, `problem: 'Не удалось выключить Remote Control: …'`.
- В `onMessage` — `remoteFromMessage(message, this.remote)`; не `null` → применить. `failed` от моста → ещё и заметка в ленте с `problem`.
- Любая смена состояния → `builder.setRemote(isRemoteLive(info))` и слушатели `onRemote`.
- **Ход с телефона:** если среди изменений `builder.apply` есть `append` пузыря с `remote: true` и `!turnRunning` → `turn += 1`, `turnRunning = true`, `setStatus('busy')`. Ход уже идёт → только пузырь (Review Focus 3).
- **Ответ с телефона:** в `onToolPermission` аборт пришёл от сигнала SDK (а не от `cancelWaits`) при живом мосте → карточка `resolvePermission(requestId, 'elsewhere')`; в `askPlan` — `resolvePlan(…, 'elsewhere')`; в `askQuestion` — `closeQuestionElsewhere(toolUseId)`. Без моста — прежнее поведение. Аборт брокеру (`askPermission`) передаётся как сейчас, поэтому поздний клик в окне ничего не делает (Review Focus 4).
- `fail()` → `REMOTE_OFF` (процесса нет — моста нет).
- `dispose()`: мост живой → `await Promise.race([driver.setRemoteControl(false), 1000 мс])` до закрытия драйвера, внутри существующего лимита — телефон увидит «выключено», а не будет ждать таймаута.

- [ ] **Step 1: Write the failing tests** (через `makeSession`, `watch`):

```ts
describe('AgentSession: Remote Control', () => {
  test('включение: подключается → на связи со ссылкой, имя уходит в CLI', async () => {
    const { session, driver } = makeSession()
    const seen: RemoteInfo[] = []; session.onRemote((i) => seen.push(i))
    await session.start()
    await session.setRemote(true, 'Qclod — проект')
    expect(seen.map((i) => i.state)).toEqual(['connecting', 'on'])
    expect(session.remote.url).toBe('https://claude.ai/code/session_fake0001')
    expect(driver.remoteCalls).toEqual([{ enabled: true, name: 'Qclod — проект' }])
  })
  test('повторное включение во время подключения не шлёт второй запрос', async () => {
    const { session, driver } = makeSession(); await session.start()
    await Promise.all([session.setRemote(true), session.setRemote(true)])
    expect(driver.remoteCalls).toHaveLength(1)
  })
  test('выключение: off и worker_shutting_down не включает обратно', async () => { /* setRemote(false) → state off; remoteCalls[1].enabled false */ })
  test('API-ключ: кнопка заблокирована, CLI не зовётся', async () => {
    const { session, driver } = makeSession({ remoteControl: { blocked: 'api_key' } })
    await session.start(); await flush()
    expect(session.remote).toEqual({ state: 'off', blocked: 'api_key' })
    await session.setRemote(true)
    expect(driver.remoteCalls).toEqual([])
  })
  test('ошибка включения — причина в состоянии и заметка в ленте', async () => {
    const { session } = makeSession({ remoteControl: { enableError: 'Remote Control requires a claude.ai subscription' } })
    const rec = watch(session); await session.start(); await session.setRemote(true)
    expect(session.remote).toMatchObject({ state: 'off', problem: REMOTE_BLOCK_TEXT.api_key })
    expect(rec.items.some((i) => i.kind === 'notice' && i.text === REMOTE_BLOCK_TEXT.api_key)).toBe(true)
  })
  test('мост упал — нет связи и заметка', async () => { /* bridge: [{state:'connected'},{state:'failed', detail:'таймаут', afterMs:10}] */ })
  test('сообщение с телефона — пузырь с пометкой, вкладка работает, затем простаивает', async () => {
    const { session, driver } = makeSession(); const rec = watch(session)
    await session.start(); await session.setRemote(true)
    driver.typeOnPhone('с телефона', [{ kind: 'text', text: 'ответ' }])
    await until(() => rec.statuses.includes('busy') && session.status === 'idle')
    expect(rec.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'с телефона', remote: true })
  })
  test('сообщение с телефона во время хода не открывает второй ход', async () => { /* send() со шагом thinking ms:200; typeOnPhone посреди; статусы: один busy до idle */ })
  test('разрешение, отвеченное с телефона, закрывается как elsewhere', async () => {
    const { session } = makeSession({ nextTurn: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'allow' }] },
      { askPermission: (_r, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ behavior: 'deny' }))) })
    const rec = watch(session); await session.start(); await session.setRemote(true)
    session.send({ text: 'запусти', attachments: [] }); await settle(session)
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'elsewhere' })
  })
  test('поздний ответ из Qclod после ответа с телефона игнорируется', async () => { /* askPermission резолвит allow через 100 мс после аборта; карточка остаётся elsewhere, правило не сохранено (permissionStore не вызывался) */ })
  test('без моста аборт SDK — по-прежнему denied', async () => { /* remoteAnswer без setRemote → state 'denied' */ })
  test('закрытие вкладки с живым мостом сначала выключает его', async () => {
    const { session, driver } = makeSession(); await session.start(); await session.setRemote(true)
    await session.dispose()
    expect(driver.remoteCalls.at(-1)).toEqual({ enabled: false })
  })
})
```

`flush`/`until` — помощники файла (существующие или короткий опрос с `setTimeout(0)`).

- [ ] **Step 2: Run** `npx vitest run tests/unit/agentSession.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — перечитать `AgentSession.ts` (этап 2 мог добавить очередь и фоновые задачи). Флаг «аборт от SDK» — локальная переменная в слушателе `opts.signal` в `onToolPermission`/`askPlan`/`askQuestion`; `cancelWaits` его не ставит.
- [ ] **Step 4: Run** `npx vitest run tests/unit/agentSession.test.ts && npm run typecheck` — Expected: PASS, без unhandled rejection в выводе.
- [ ] **Step 5: Commit**

```bash
git add src/main/agent/AgentSession.ts tests/unit/agentSession.test.ts
git commit -m "feat: a tab's session runs remote control and follows the phone"
```

---

### Task 7: Вкладка и IPC

**Files:**
- Modify: `src/main/tabs/TabController.ts`, `src/main/agentIpc.ts`, `src/shared/channels.ts`, `src/preload/index.ts`, `src/renderer/global.d.ts`
- Test: `tests/unit/tabController.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/unit/channels.test.ts`

**Interfaces:**
- Consumes: `AgentSession.remote/onRemote/setRemote` (Task 6).
- Produces:
  - `CHANNELS.agentRemote = 'agent:remote'` (в `INVOKE_CHANNELS`)
  - preload: `setRemote(id: TabId, enabled: boolean): Promise<void>`
  - `TabState.remote` заполняется контроллером; в `tabs.json` не пишется (`persist` выбирает поля — проверить, что так и осталось)

Поведение:
- `wire` подписывает `session.onRemote` → `patch(id, { remote: info })` только для текущей сессии вкладки (тем же `current()`).
- `adopt` (новая сессия после рестарта/восстановления): `patch(id, { remote: session.remote })`; если у вкладки был живой мост — заметка в ленте `Remote Control выключен: сессия перезапущена. Включите снова, если нужно.` (Review Focus 2).
- IPC `agentRemote(id, enabled)`: `id` строка, `enabled` boolean, иначе — тихо выйти; сессии нет — выйти; имя — `title` вкладки из `controller.list()`.
- `sanitizeTabPatch` (из `tabs:update`) не пропускает `remote` из окна.

- [ ] **Step 1: Write the failing tests:**
  - `tabController.test.ts`: `'Remote Control доходит до вкладки и не пишется в tabs.json'` — активная вкладка, `setRemote(true)` у её сессии → последний `onChanged` содержит `remote.state === 'on'`; прочитанный `tabs.json` не содержит `remote`.
  - `tabController.test.ts`: `'перезапуск гасит значок и оставляет заметку'` — живой мост → `restart(id)` → `remote.state === 'off'`, в ленте заметка с текстом выше.
  - `ipcValidation.test.ts`: `'agent:remote принимает только id-строку и boolean'` — `('t1', 'yes')`, `(1, true)` не зовут `setRemote`; `('t1', true)` зовёт с `(true, <title>)`.
  - `ipcValidation.test.ts`: `'tabs:update не даёт окну подменить remote'`.
  - `channels.test.ts`: существующие проверки списков покрывают новый канал (добавить его в ожидаемые, если тест сверяет явно).
- [ ] **Step 2: Run** `npx vitest run tests/unit/tabController.test.ts tests/unit/ipcValidation.test.ts tests/unit/channels.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — перечитать `TabController.ts` и `agentIpc.ts`; канал и preload — по образцу `agentEffort`/`setEffort`.
- [ ] **Step 4: Run** те же тесты + `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/tabs/TabController.ts src/main/agentIpc.ts src/shared/channels.ts src/preload/index.ts src/renderer/global.d.ts tests/unit/tabController.test.ts tests/unit/ipcValidation.test.ts tests/unit/channels.test.ts
git commit -m "feat: remote control state reaches the tab and the window can toggle it"
```

---

### Task 8: `/remote-control` — тот же переключатель

**Files:**
- Modify: `src/shared/commandFilter.ts`, `src/renderer/input/slash.ts`
- Test: `tests/unit/commandFilter.test.ts`, `tests/unit/slash.test.ts`

**Interfaces:**
- Produces:
  - `UNAVAILABLE` и пометка «работает только в терминале» удаляются; `markUnavailable` остаётся только для описаний локальных команд (переименовать не нужно, комментарий обновить).
  - `LOCAL_COMMANDS['remote-control'] = 'Включить или выключить Remote Control для этой вкладки'`; в списке, который дополняет `withLocalCommands`, у неё `aliases: ['rc']`.
  - `markRemote(commands: CommandInfo[], blockedText: string | null): CommandInfo[]` — `blockedText` не `null` → у `remote-control` `unavailableReason = blockedText`.
  - `SlashOutcome` + `{ kind: 'remote' }`; `acceptCommand` для `remote-control` → `{ kind: 'remote' }`.
  - `bareRemoteToggle(text: string): boolean` — черновик целиком `/remote-control` или `/rc` (с пробелами по краям); с аргументом — тоже `true` (имя не берём: переключатель один, имя — название вкладки).

- [ ] **Step 1: Write the failing tests** — в `commandFilter.test.ts` заменить тесты, которые ждали `unavailableReason` у `remote-control`/`rc`, на:

```ts
test('remote-control больше не помечен недоступным', () => {
  expect(markUnavailable([cmd('remote-control'), cmd('rc')]).every((c) => !c.unavailableReason)).toBe(true)
})
test('remote-control есть в списке, даже если сессия его не прислала', () => {
  expect(withLocalCommands([]).find((c) => c.name === 'remote-control')).toMatchObject({ aliases: ['rc'] })
})
test('markRemote ставит причину блокировки', () => {
  expect(markRemote(withLocalCommands([]), 'нет подписки').find((c) => c.name === 'remote-control')?.unavailableReason).toBe('нет подписки')
})
```

  В `slash.test.ts`: `acceptCommand(remote) → {kind:'remote'}`; `bareRemoteToggle('/rc ') === true`, `bareRemoteToggle('/remote-control мой') === true`, `bareRemoteToggle('/rcx') === false`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/commandFilter.test.ts tests/unit/slash.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Ветку `{kind:'remote'}` в `Composer` и перехват `bareRemoteToggle` при отправке подключает Task 10 (здесь только чистые функции; `Composer` должен компилироваться — `switch` по исходу получает `case 'remote'` с вызовом нового пропа `onToggleRemote`, который Task 10 прокинет; до того — проп необязательный).
- [ ] **Step 4: Run** те же тесты + `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/shared/commandFilter.ts src/renderer/input/slash.ts src/renderer/components/Composer.tsx tests/unit/commandFilter.test.ts tests/unit/slash.test.ts
git commit -m "feat: /remote-control toggles remote control instead of being greyed out"
```

---

### Task 9: QR-код, нарисованный у себя

**Files:**
- Modify: `package.json`, `package-lock.json` (`"uqr": "0.1.3"` в `dependencies`, без `^`)
- Create: `src/renderer/panel/qrPath.ts`, `src/renderer/components/QrCode.tsx`
- Modify: `src/renderer/styles/tokens.css` (`--qr-paper`, `--qr-ink`)
- Test: `tests/unit/qrPath.test.ts`

Выбор библиотеки: `uqr@0.1.3` — MIT, ноль зависимостей, ESM с типами, `encode(text, {ecc, border})` отдаёт `{ size, data: boolean[][] }`; версия опубликована 2026-04-03 (`npm view uqr time`). `qrcode-generator@2.0.4` тоже годится, но в 7 раз тяжелее. Сеть не нужна: всё считается в окне.

**Interfaces:**
- Produces:
  - `qrPath(grid: boolean[][]): string` — один `d` для `<path>`: каждая тёмная клетка `M{x} {y}h1v1h-1z`, строки слева направо, сверху вниз.
  - `qrMatrix(text: string): boolean[][]` — `encode(text, { ecc: 'M', border: 2 }).data`.
  - `QrCode({ text, size = 168, label }: { text: string; size?: number; label: string })` — `<svg role="img" aria-label={label} viewBox="0 0 n n" width={size} height={size} shape-rendering="crispEdges" data-testid="remote-qr">`, фон — `rect` цвета `var(--qr-paper)`, модули — `path` цвета `var(--qr-ink)`. `useMemo` по `text`. Никакого `dangerouslySetInnerHTML`.

- [ ] **Step 1: Write the failing test:**

```ts
test('qrPath рисует только тёмные клетки', () => {
  expect(qrPath([[true, false], [false, true]])).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
})
test('матрица ссылки — квадрат версии не меньше 1 с рамкой', () => {
  const m = qrMatrix('https://claude.ai/code/session_fake0001')
  expect(m.length).toBeGreaterThanOrEqual(21 + 4)
  expect(m.every((row) => row.length === m.length)).toBe(true)
  expect(m[0]!.every((cell) => cell === false)).toBe(true) // рамка светлая
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/qrPath.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Проверить `npm view uqr@0.1.3 version license dependencies` (ожидается `0.1.3`, MIT, без зависимостей), `npm install uqr@0.1.3 --save-exact --ignore-scripts`; реализовать `qrPath.ts` и `QrCode.tsx`; токены в `tokens.css`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/qrPath.test.ts && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/renderer/panel/qrPath.ts src/renderer/components/QrCode.tsx src/renderer/styles/tokens.css tests/unit/qrPath.test.ts
git commit -m "feat: QR code drawn locally from the session link"
```

---

### Task 10: Окно — кнопка, панель, значок на вкладке, пузыри и карточки

**Files:**
- Create: `src/renderer/components/RemoteSection.tsx`, `src/renderer/components/RemoteSection.css`
- Modify: `SidePanel.tsx`/`.css`, `StatusLine.tsx`/`.css`, `TabStrip.tsx` (+ CSS вкладок, где он сейчас), `RibbonItem.tsx` (+ `Ribbon.css`), `PermissionCard.tsx`, `PlanCard.tsx`, `QuestionCard.tsx`, `ChatPane.tsx`, `Composer.tsx`, `App.tsx` — все в `src/renderer/…`; **перечитать каждый перед правкой**
- Test: `tests/e2e/remote.spec.ts`

**Interfaces:**
- Consumes: `TabState.remote`, `window.qclod.setRemote` (Task 7), `REMOTE_STATE_LABEL`, `REMOTE_BLOCK_TEXT`, `isRemoteLive` (Task 1), `markRemote`, `bareRemoteToggle`, `{kind:'remote'}` (Task 8), `QrCode` (Task 9), состояния `elsewhere`/`remote` в ленте (Task 5).
- Produces:
  - `RemoteSection({ remote, onToggle }: { remote: RemoteInfo; onToggle: (enabled: boolean) => void })`
  - `SidePanel` получает `remote: RemoteInfo` и `onRemote: (enabled: boolean) => void` от `App` (из вкладки `activeTabId`)
  - `StatusLine` получает `remote: RemoteInfo` и `onToggleRemote: () => void`
  - `ChatPane` получает `onShowPanel: () => void` от `App` (показать панель тем же механизмом, что и кнопка панели — см. `app/panelVisibility.ts`); включение из строки состояния или `/remote-control` вызывает `setRemote(tabId, !isRemoteLive(remote))` и, при включении, `onShowPanel()`

Тексты и `data-testid`:

| Место | Что | testid |
|---|---|---|
| Строка состояния, кнопка | подсказка выкл.: `Remote Control: продолжить эту сессию с телефона или claude.ai`; вкл.: слово состояния рядом со значком; заблокировано — `disabled`, подсказка = `REMOTE_BLOCK_TEXT[blocked]` | `remote-toggle` (+ `data-state`) |
| Вкладка | `Smartphone` 11 px; строка в `title`: `Remote Control: ${REMOTE_STATE_LABEL[state]}`; при `off` значка нет | `tab-remote` (+ `data-state`) |
| Панель, выкл. | заголовок `Remote Control`; `Продолжайте эту сессию с телефона или claude.ai.`; кнопка `Включить`; заблокировано — текст причины вместо кнопки; `problem` — строкой под ним | `panel-remote` |
| Панель, вкл. | точка и слово состояния; `QrCode` с `label="QR-код ссылки на сессию"`; подсказка `Наведите камеру телефона или откройте ссылку на claude.ai.`; ссылка текстом; `Открыть в браузере` (→ `openExternal`); `Выключить`; заметка `Закроете вкладку — сессия на телефоне станет недоступна.` | `panel-remote`, `remote-qr`, `remote-link`, `remote-open`, `remote-off` |
| `connecting` | вместо QR — `Подключаемся к claude.ai…`; `Выключить` доступна | |
| Пузырь с телефона | `Smartphone` 12 px + `с телефона`; подсказка `Написано через Remote Control — с телефона или claude.ai` | `user-from-phone` |
| Карточка разрешения/плана | итог `ответили с телефона или claude.ai` | существующие testid карточек |
| Вопрос с `elsewhere` | карточка закрыта, итог тот же | |

Слэш-меню: список команд в `Composer` проходит через `markRemote(commands, blocked ? REMOTE_BLOCK_TEXT[blocked] : null)`; исход `{kind:'remote'}` и отправка черновика, где `bareRemoteToggle(draft)`, вызывают `onToggleRemote` и очищают поле (в сессию не уходит).

Вид — по разделу «Решения по виду»: токены состояний, QR на `--qr-paper`, ссылка `--font-mono` с `overflow-wrap: anywhere` и `user-select: text`, фокус клавиатуры виден на всех кнопках, при `prefers-reduced-motion` никакой анимации у точки состояния (у `connecting` — мягкая пульсация только без этой настройки).

- [ ] **Step 1: Write the failing e2e** — `tests/e2e/remote.spec.ts` (каркас `launch/close` — как в `permissions.spec.ts`):
  - `'кнопка включает Remote Control: значок на вкладке, ссылка и QR в панели, «Выключить» гасит'` — клик `remote-toggle` → `tab-remote[data-state="on"]`, `remote-link` содержит `https://claude.ai/code/session_fake0001`, `remote-qr` видим и содержит `path`; клик `remote-off` → `tab-remote` исчезает, в `panel-remote` кнопка `Включить`.
  - `'/remote-control в поле ввода — тот же переключатель'` — ввести `/remote-control`, Enter → `tab-remote[data-state="on"]`; в ленте нет пузыря `/remote-control`.
  - `'сообщение с телефона — пузырь человека с пометкой и ответ агента'` — сценарий `remoteControl.phoneTurns: [{ text: 'проверь тесты', afterMs: 300, steps: [{kind:'text', text:'тесты зелёные'}] }]` → после включения в ленте пузырь с `user-from-phone` и текстом, затем `тесты зелёные`.
  - `'разрешение, на которое ответили с телефона, закрывается в Qclod'` — `nextTurn: [SETTLE, { kind: 'remoteAnswer', name: 'Bash', input: { command: 'npm test' }, decision: 'allow', afterMs: 1500 }]`; включить, отправить сообщение → карточка видна и ждёт; через ~1,5 с — карточка закрыта с текстом `ответили с телефона или claude.ai`.
  - `'вход по API-ключу: кнопка неактивна и объясняет почему'` — `remoteControl: { blocked: 'api_key' }` → `remote-toggle` `disabled`, `panel-remote` содержит `только при входе через подписку claude.ai`; в слэш-меню `/remote-control` неактивна с той же причиной.
  - `'мост потерял связь — значок красный, причина в панели'` — `bridge: [{state:'connected'},{state:'failed', detail:'таймаут', afterMs: 300}]` → `tab-remote[data-state="failed"]`, текст `Связь с claude.ai потеряна. таймаут`.
- [ ] **Step 2: Run** `npm run build:e2e && npx playwright test tests/e2e/remote.spec.ts` — Expected: FAIL (нет `remote-toggle`).
- [ ] **Step 3: Implement** компоненты и проводку по таблицам. `RemoteSection` в `SidePanel` идёт первой, пока `remote.state !== 'off'`, иначе — последней секцией.
- [ ] **Step 4: Run** `npm run build:e2e && npx playwright test tests/e2e/remote.spec.ts` и затем `npm run test:e2e` целиком (затронуты панель, строка состояния, вкладки и карточки) — Expected: PASS. Снять скриншот панели во включённом состоянии из e2e (`win.screenshot` в `tests/.artifacts`) и посмотреть его: QR квадратный и читаемый, ссылка не вылезает за панель, на ширине панели 268 px подсказка уходит под QR.
- [ ] **Step 5: Commit**

```bash
git add src/renderer tests/e2e/remote.spec.ts
git commit -m "feat: remote control button, panel with link and QR, phone marks in the ribbon"
```

---

### Task 11: Итоговая проверка и показ владельцу

**Files:** — (только проверка; правки — отдельными коммитами `fix: …`, если что-то всплывёт)

- [ ] **Step 1:** `npm run typecheck` — Expected: 0 ошибок.
- [ ] **Step 2:** `npm run test:unit` — Expected: всё зелёное, в выводе нет `Unhandled Rejection`.
- [ ] **Step 3:** `npm run test:e2e` — Expected: всё зелёное.
- [ ] **Step 4:** `npm run check:seams` после `npm run build` — Expected: в релизной сборке нет фейка и `typeOnPhone`.
- [ ] **Step 5:** `grep -rn "работает только в терминале" src` — Expected: пусто.
- [ ] **Step 6:** Передать владельцу (настоящее приложение и телефон — его проверка, агент их не запускает), одним сообщением:
  - как проверить: открыть вкладку, нажать значок телефона в строке состояния, отсканировать QR, написать с телефона, ответить с телефона на разрешение, нажать «Выключить», закрыть вкладку при включённом мосте;
  - что известно заранее: метод внутренний — при обновлении Claude Code может перестать работать, тогда кнопка станет серой с причиной; какой именно ответ дали с телефона (разрешили или отклонили), SDK не сообщает — карточка пишет «ответили с телефона или claude.ai», а что было дальше, видно по карточке инструмента;
  - ждать его оценки, вперёд не уходить.

---

## Self-review

- **Покрытие раздела 8:** включение/выключение — Task 4, 6; доступность и серая кнопка с причиной — Task 1, 4, 10; статус по `bridge_state`/`worker_shutting_down` и значок — Task 1, 6, 7, 10; ссылка, QR, «Выключить» — Task 9, 10; подписка простыми словами — Task 1, 10; сообщения с телефона — Task 3, 5, 6, 10; ответ на разрешение с телефона — Task 3, 5, 6, 10; офлайн при закрытии вкладки — Task 6 (чистое выключение), Task 10 (заметка); `UNAVAILABLE` убран, `/remote-control` = переключатель — Task 8, 10; закреплённая версия и проверка метода — Task 2, 4.
- **Имена сквозь задачи:** `setRemoteControl`, `remoteAvailability`, `RemoteInfo`, `RemoteBlock`, `setRemote`, `onRemote`, `remote` (на вкладке и на пузыре), `elsewhere`, `typeOnPhone`, `remoteCalls`, `agentRemote` — одинаковы во всех задачах.
- **Не покрыто сознательно:** восстановление моста после перезапуска вкладки (`reattach_session_id`) — не просили; выключение по умолчанию и заметка вместо этого. Учёт `origin` у сообщений с телефона — форма не подтверждена; пометка ставится по «не эхо при живом мосте».
