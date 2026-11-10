# Qclod v3 — Этап 4: установка и обновления. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Друг скачивает установщик с GitHub Releases, проходит оформленный русский мастер, при первом запуске Qclod сам ставит Claude Code и проводит через вход без ручного терминала, а новые версии приходят сами и ставятся перезапуском.

**Architecture:** Вся логика — в главном процессе, в маленьких модулях с внедряемыми зависимостями: `setup/install.ts` (winget, затем npm), `setup/auth.ts` (опрос `claude auth status` и окно входа), `update/updater.ts` (обёртка над `electron-updater`). Каждый модуль покрыт юнит-тестами с подделками, а в e2e подменяется лазейкой под `__QCLOD_TEST_SEAMS__` (`QCLOD_FAKE_INSTALL`, `QCLOD_FAKE_AUTH`, `QCLOD_FAKE_UPDATE`), которой в релизной сборке нет (`npm run check:seams`). Окно получает только итоговые состояния (`EnvironmentReport`, `LoginProgress`, `UpdateState`) и рисует их в `SetupScreen` и `UpdateBanner`. Выпуск — GitHub Actions на тег `v*`, `electron-builder --publish always` в публичный `SOJuse/qclod`.

**Tech Stack:** Electron 33, electron-vite 2, electron-builder 25.1.8, **`electron-updater` 6.3.9** (новая зависимость, точная версия), React 18, TypeScript 5, Vitest 2, Playwright `_electron` против `tests/fixtures/fake-sdk`, NSIS (MUI2, встроен в electron-builder), GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md`, раздел 7 целиком. Плюс два хвоста с пометкой STAGE 4: `.superpowers/sdd/2026-11-10-qclod-v3-stage1-bugs/progress.md:66` (findAgent глотает понятную ошибку про `.cmd`-обёртку) и `.superpowers/sdd/2026-11-10-qclod-v3-stage2-chat/progress.md:10` (новая вкладка без входа показывает только сырую ошибку, «Войти» есть лишь на пути resume).

## Global Constraints

- Платформа — только Windows 11 x64.
- **Каждая задача начинается с падающего теста.** Тест, который не падает на текущем коде, переписывается.
- e2e — только против `tests/fixtures/fake-sdk` и фейков этого этапа; ни один тест не запускает настоящий `claude`, `winget`, `npm install` или сеть.
- Каждая новая лазейка читается **на месте использования** как `__QCLOD_TEST_SEAMS__ ? process.env['X'] : undefined` (см. `src/main/buildFlags.d.ts`) и в той же задаче вписывается в `SEAM` в `scripts/releaseSeams.mjs` вместе с именами её глобальных счётчиков; `tests/unit/releaseSeams.test.ts` получает строку на каждое имя.
- Qclod **не читает** файлы учётных данных. Вход проверяется только выводом `claude auth status --json`. Из этого вывода берётся только `loggedIn`; stdout (в нём почта и организация) никуда не пишется: ни в лог, ни в окно, ни в ошибку.
- TLS не отключать и проверку сертификатов не ослаблять. Часы этой машины отстают примерно на 3 часа, отсюда `certificate is not yet valid`; такая ошибка обновления — тихая запись в консоль, не повод для обходов.
- Автор везде — `SOJuse`. Рабочая почта владельца не появляется ни в одном файле репозитория. `appId` — `io.github.sojuse.qclod`, после первого публичного релиза не меняется.
- Репозиторий — `https://github.com/SOJuse/qclod`, публичный. Создание репозитория, переписывание авторов истории и push делает контроллер отдельным шагом **вне этого плана**. Задачи только готовят файлы.
- Workflow не требует секретов, кроме встроенного `GITHUB_TOKEN`.
- Без подписи кода (`signAndEditExecutable: false` остаётся).
- Весь текст для пользователя — по-русски, просто, без воды. Точные строки там, где они заданы в плане, копируются как есть.
- **Этап 3 идёт параллельно в другой ветке.** Из интерфейса трогаются только: `SetupScreen.tsx/.css`, новый `UpdateBanner.tsx/.css`, одна вставка в `App.tsx`, один необязательный проп в `SettingsScreen.tsx`, одна строка в `RibbonItem.tsx`. `tokens.css` **не меняется**; CSS — только через уже существующие `var(--…)`. Захардкоженный цвет в CSS компонента ревьюер возвращает.
- Иконки — `lucide-react@1.62.0`, без Unicode-глифов (`✓`, `•` в `SetupScreen` заменяются).
- В сообщениях коммитов **нет** подписей соавторов и упоминаний Claude/ИИ. Стиль: `feat: …`, `fix: …`, `build: …`, `docs: …`.
- Команды проверки: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`. Один файл: `npx vitest run tests/unit/<file>.test.ts`; `npm run build:e2e && npx playwright test tests/e2e/<file>.spec.ts`.
- Перед правкой `TabController.ts` и `AgentSession.ts` — `git log -3 -- <файл>`; номера строк ориентировочные.
- Порядок: задачи 1–10 по номерам.

## Review Focus

1. **Путь к `claude.exe` с пробелом или кириллицей** (`C:\Users\Иван Иванов\…`): окно входа обязано запустить именно его, а не упасть на кавычках. Сейчас `setupTerminal` передаёт путь без кавычек. Тест — Task 4, `loginCommandLine` с пробелом и кириллицей.
2. **Нет сети или TLS-ошибка из-за отстающих часов при проверке обновления:** приложение работает как обычно, баннера нет, нет unhandled rejection, следующая проверка по расписанию. Тест — Task 7, источник одновременно отвергает промис и шлёт `error`.
3. **Человек закрыл окно входа, не войдя:** ожидание само кончается через 10 минут, экран говорит, что делать, повторное «Войти» начинает заново, а не запускает второй опрос. Тест — Task 4 (`LoginWatch` timeout и двойной `start`), Task 5 (e2e тайм-аута).
4. **«Перезапустить» для обновления, пока агент работает, при включённом «сворачивать в трей»:** приложение действительно выходит (не прячется в трей), а баннер заранее предупреждает, что работа прервётся. Тест — Task 7 (`restartWarning`) и пункт чек-листа (Task 10).
5. **winget есть, но установка через него падает** (сломан источник, политика компании): Qclod сам пробует npm, а если не вышло и так — показывает «Открыть настройки» и что сделать руками. Тест — Task 3 (цепочка), Task 5 (e2e).

Плюс старый CLI без подкоманды `auth`: вход считается «неизвестно», работа не блокируется (Task 4).

## Карта файлов

| Файл | Что делает | Задача |
|---|---|---|
| `package.json`, `electron-builder.yml`, `src/shared/appId.ts` (новый), `src/main/index.ts` | автор, appId, publish, AUMID, скрипты | 1, 9 |
| `src/main/setup/findAgent.ts`, `src/main/setup/environment.ts`, `src/main/agent/AgentSession.ts`, `src/shared/types.ts` | понятная причина «агент не найден» | 2 |
| `src/main/setup/install.ts`, `src/main/ipc.ts` | winget → npm, фейковый установщик | 3 |
| `src/main/setup/auth.ts` (новый), `src/main/ipc.ts`, `src/shared/channels.ts`, `src/preload/index.ts`, `playwright.config.ts` | статус входа, окно входа, опрос | 4 |
| `src/renderer/components/SetupScreen.tsx/.css`, `src/renderer/app/App.tsx`, `src/renderer/components/SettingsScreen.tsx` | экран первого запуска | 5 |
| `src/main/agent/startFailure.ts`, `AgentSession.ts`, `src/main/tabs/TabController.ts`, `RibbonItem.tsx`, `tests/fixtures/fake-sdk/*` | «Войти» в новой вкладке, продолжение после входа | 6 |
| `src/main/update/updater.ts` (новый), `src/renderer/components/UpdateBanner.tsx/.css` (новые), `App.tsx`, channels/preload | автообновление | 7 |
| `scripts/installerArt.mjs`, `scripts/make-installer-art.mjs` (новые), `build/installer.nsh` (новый), `electron-builder.yml`, `.gitignore` | мастер установки | 8 |
| `.github/workflows/release.yml`, `scripts/releaseTag.mjs`, `scripts/check-release-tag.mjs` (новые), `package.json` | выпуск | 9 |
| `README.md` (новый), `docs/superpowers/checklists/release-smoke.md` | для друзей и перед релизом | 10 |

---

### Task 1: Автор SOJuse, новый appId, адрес обновлений

**Files:**
- Modify: `package.json` (`author`, новое поле `repository`)
- Modify: `electron-builder.yml:1-3` (`appId`, `copyright`), `electron-builder.yml` хвост (`publish`)
- Create: `src/shared/appId.ts`
- Modify: `src/main/index.ts` (вызов `app.setAppUserModelId` до `whenReady`)
- Modify: `tests/unit/mentions.test.ts:25` (почта в тесте → `name@example.com`, позиция курсора пересчитывается под новую строку)
- Modify: `docs/superpowers/specs/2026-11-10-qclod-v3-design.md:307,317` (почта → «рабочую почту владельца»)
- Test: `tests/unit/buildConfig.test.ts` (новый)

**Interfaces:**
- Produces: `export const APP_ID = 'io.github.sojuse.qclod'` в `src/shared/appId.ts`; `publish` в `electron-builder.yml`, на который опираются Task 7 и Task 9.

- [ ] **Step 1: Write the failing test** — `tests/unit/buildConfig.test.ts` читает `package.json` (JSON) и `electron-builder.yml` (как текст, построчно регэкспами — YAML-парсера в зависимостях нет и не добавлять):

```ts
test('автор — SOJuse, почты нет', () => {
  expect(pkg.author).toBe('SOJuse')
  expect(pkg.repository).toEqual({ type: 'git', url: 'https://github.com/SOJuse/qclod.git' })
  expect(yml).toMatch(/^appId: io\.github\.sojuse\.qclod$/m)
  expect(yml).toMatch(/^copyright: Copyright © 2026 SOJuse$/m)
  expect(JSON.stringify(pkg) + yml).not.toMatch(/sojuse|@[a-z0-9-]+\.[a-z]{2,}/i)
})
test('appId приложения совпадает с установщиком', () => {
  expect(yml).toContain(`appId: ${APP_ID}`)
})
test('обновления берутся из публичных релизов SOJuse/qclod', () => {
  expect(yml).toMatch(/^publish:\n  provider: github\n  owner: SOJuse\n  repo: qclod\n  releaseType: release$/m)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/buildConfig.test.ts` — Expected: FAIL на `author`.
- [ ] **Step 3: Implement.** Значения ровно из теста. `publish: null` и комментарий «The spec has no auto-update» заменяются блоком `publish` (`releaseType: release` обязателен: по умолчанию electron-builder делает черновик, а черновики `electron-updater` не видит). В `src/main/index.ts` на верхнем уровне, рядом с остальной ранней настройкой: `app.setAppUserModelId(APP_ID)` — иначе уведомления Windows не совпадут с ярлыком, который NSIS создаёт с этим AUMID.
- [ ] **Step 4: Run** `npx vitest run tests/unit/buildConfig.test.ts tests/unit/mentions.test.ts` — PASS; `git grep -n sojuse` — пусто.
- [ ] **Step 5: Commit** `build: author SOJuse, appId io.github.sojuse.qclod, publish to GitHub releases`

---

### Task 2: «Агент не найден» с настоящей причиной

Хвост этапа 1: `findAgent` ловит `AgentNotFoundError` и возвращает `null`, поэтому текст про `.cmd`-обёртку, который уже пишет `resolveExecutable`, до человека не доходит.

**Files:**
- Modify: `src/main/setup/findAgent.ts`
- Modify: `src/main/setup/environment.ts` (параметры, `ToolReport.problem`)
- Modify: `src/shared/types.ts` (`ToolReport.problem?: string`)
- Modify: `src/main/agent/AgentSession.ts:~376-386` (резолвер по умолчанию)
- Test: `tests/unit/environment.test.ts`

**Interfaces:**
- Produces: `locateAgent(configured: string, env: NodeJS.ProcessEnv): string` — бросает `AgentNotFoundError`; если по дороге встретилась неисправимая `.cmd`-обёртка, у ошибки заполнен `shim`. `findAgent` остаётся (`try locateAgent catch → null`), его тесты не трогаются.
- Produces: `checkEnvironment(agentPath: string, deps?: EnvironmentDeps): Promise<EnvironmentReport>`, где `interface EnvironmentDeps { env?: NodeJS.ProcessEnv; detect?: () => Promise<InstallMethod | null>; authStatus?: (agent: string) => Promise<AuthStatus> }` (`authStatus` подключается в Task 4, сейчас поле можно объявить позже). `ToolReport.problem` заполнен, только если ошибка несёт `shim` или путь в настройках не пустой и не `claude` — на чистой машине «не нашёл "claude"» не показывается, там говорит шаг установки.

- [ ] **Step 1: Write the failing tests** в `tests/unit/environment.test.ts`:
  - `locateAgent отдаёт текст про .cmd-обёртку` — во временном `APPDATA\npm` лежит `claude.cmd` с `"%dp0%\node_modules\x\missing.exe" %*`; `expect(() => locateAgent('claude', { APPDATA, PATH: '', PATHEXT: '.EXE;.CMD' })).toThrow(/\.cmd-обёртка/)`.
  - `checkEnvironment показывает причину` — то же окружение через `deps.env`: `report.agent.found === false`, `report.agent.problem` совпадает с `/\.cmd-обёртка/`.
  - `неверный путь в настройках назван` — `checkEnvironment('C:/нет/такого/claude.exe', { env, detect: async () => 'winget' })`: `problem` содержит `C:/нет/такого/claude.exe`.
  - `на чистой машине причины нет` — `checkEnvironment('claude', { env: { PATH: '' }, detect: async () => null })`: `problem` `undefined`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/environment.test.ts` — FAIL (`locateAgent` не экспортирован).
- [ ] **Step 3: Implement.** `locateAgent`: та же последовательность, что сейчас в `findAgent` (PATH, затем `knownLocations` только для `claude`); первый встреченный `err.shim` запоминается, в конце `throw new AgentNotFoundError(wanted, shim)`. `checkEnvironment` берёт `deps.env ?? process.env`, `deps.detect ?? detectInstallMethod`. В `AgentSession` резолвер по умолчанию — `(p) => locateAgent(p, process.env)`, и ошибка уходит в `fail` со своим текстом.
- [ ] **Step 4: Run** `npx vitest run tests/unit/environment.test.ts tests/unit/agentSession.test.ts tests/unit/resolveExecutable.test.ts` — PASS.
- [ ] **Step 5: Commit** `fix: a .cmd wrapper that cannot be unwrapped is named, not reported as missing`

---

### Task 3: Установка — сначала winget, потом npm

**Files:**
- Modify: `src/main/setup/install.ts`
- Modify: `src/main/ipc.ts:34-57` (обработчики `setupCheck`, `setupInstall`)
- Modify: `scripts/releaseSeams.mjs`, `tests/unit/releaseSeams.test.ts`
- Test: `tests/unit/install.test.ts`

**Interfaces:**
- Produces: `detectInstallMethods(): Promise<InstallMethod[]>` — `['winget','npm']` в порядке предпочтения, только то, что запускается; `detectInstallMethod()` = первый или `null` (как сейчас, для отчёта).
- Produces: `installWithFallback(methods: InstallMethod[], onOutput: (line: string) => void, onDone: (ok: boolean) => void, start?: typeof installAgent): InstallHandle`.
- Produces (лазейка): `QCLOD_FAKE_INSTALL` = JSON `{ methods: InstallMethod[]; results: boolean[]; createAgentAt?: string }`. В `ipc.ts` при ней `detect` и `start` подменяются: фейковый `start(method)` пишет строку `фейковая установка: <method>` и через 50 мс завершает с `results[i]`; при успехе последнего шага создаётся пустой файл `createAgentAt`.

- [ ] **Step 1: Write the failing tests** (`start` — подделка, возвращающая `InstallHandle` и сохраняющая `onDone`):
  - `winget упал — пробует npm`: методы `['winget','npm']`, первый `onDone(false)`, второй `onDone(true)` → итог `true`, ровно один вызов `onDone`, в выводе строка `winget не справился — пробую через npm.`
  - `оба упали — false один раз`.
  - `отмена не запускает запасной путь`: `handle.cancel()` во время winget, затем winget `onDone(false)` → `start` вызван один раз, итог `false`.
  - `пустой список — сразу false и строка` `Нечем установить: нет ни winget, ни Node.js.`
  - `releaseSeams`: `seamsIn("process.env['QCLOD_FAKE_INSTALL']")` содержит имя.
- [ ] **Step 2: Run** `npx vitest run tests/unit/install.test.ts tests/unit/releaseSeams.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Переход к следующему методу — только если предыдущий кончился неуспехом и отмены не было; `cancel` проксируется на текущий handle. `setupInstall` в `ipc.ts` вызывает `installWithFallback(await detect(), say, done, start)` внутри `InstallSlot.start`, как сейчас. Строку `Не нашёл, чем установить…` в `ipc.ts` заменяет строка из `installWithFallback`. `SEAM` дополняется `FAKE_INSTALL`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/install.test.ts tests/unit/releaseSeams.test.ts` — PASS; `npm run typecheck` — чисто.
- [ ] **Step 5: Commit** `feat: install falls back to npm when winget fails`

---

### Task 4: Вход без терминала — `claude auth login` и опрос `claude auth status`

Сверено с CLI 2.1.317 на машине владельца: `claude auth status` по умолчанию печатает JSON (`--json`), в нём `loggedIn: boolean` и личные поля; `claude auth login` открывает вход через браузер.

**Files:**
- Create: `src/main/setup/auth.ts`
- Modify: `src/main/setup/environment.ts` (поле `auth`, правило `ready`)
- Modify: `src/shared/types.ts` (`AuthStatus`, `LoginProgress`, `EnvironmentReport.auth`)
- Modify: `src/shared/channels.ts` (`setupLogin` вместо `setupTerminal`; событие `setupLoginProgress`), `tests/unit/channels.test.ts`
- Modify: `src/preload/index.ts` (`login()`, `onLoginProgress(cb)`; `openTerminal` удаляется)
- Modify: `src/main/ipc.ts` (обработчик `setupLogin`, `BaseIpcDeps.onLoggedIn?: () => void`; `setupTerminal` удаляется)
- Modify: `src/renderer/components/RibbonItem.tsx:47` (`window.qclod.login()`)
- Modify: `playwright.config.ts` (по умолчанию `process.env['QCLOD_FAKE_AUTH'] ??= '{"sequence":["in"]}'`)
- Modify: `scripts/releaseSeams.mjs`, `tests/unit/releaseSeams.test.ts`
- Test: `tests/unit/auth.test.ts` (новый), `tests/unit/environment.test.ts`

**Interfaces:**
- Produces: `type AuthStatus = 'in' | 'out' | 'unknown'`; `type LoginProgress = 'waiting' | 'in' | 'timeout'`; `EnvironmentReport.auth: AuthStatus | null` (`null`, когда агента нет); `ready = agent.found && auth !== 'out'`.
- Produces в `auth.ts`:
  - `parseAuthStatus(stdout: string, exitCode: number | null): AuthStatus`
  - `readAuthStatus(agent: string, exec?: ExecLike): Promise<AuthStatus>`, `type ExecLike = (file: string, args: string[], opts: { timeout: number; windowsHide: true }) => Promise<{ stdout: string; code: number | null }>`; `AUTH_STATUS_TIMEOUT_MS = 15000`
  - `loginCommandLine(agent: string): string`
  - `openLoginWindow(agent: string): void`
  - `class LoginWatch { constructor(deps: LoginWatchDeps); start(): void; stop(): void; readonly running: boolean }`, `interface LoginWatchDeps { check: () => Promise<AuthStatus>; onProgress: (p: LoginProgress) => void; intervalMs?: number; maxMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void }`; `LOGIN_POLL_MS = 2000`, `LOGIN_WATCH_MAX_MS = 600000`.
- Produces (preload): `login(): Promise<void>`, `onLoginProgress(cb: (p: LoginProgress) => void): () => void`.
- Produces (лазейка): `QCLOD_FAKE_AUTH` = JSON `{ sequence: AuthStatus[]; pollMs?: number; maxMs?: number }` (идут в `LoginWatch` как `intervalMs`/`maxMs`) — каждая проверка берёт следующий элемент, последний повторяется; `openLoginWindow` заменяется на `globalThis.__qclodLoginOpens.push(agent)`.

- [ ] **Step 1: Write the failing tests** в `tests/unit/auth.test.ts`:

```ts
test.each([
  ['{"loggedIn":true,"authMethod":"claude.ai","email":"x@y.z"}', 0, 'in'],
  ['{"loggedIn":false}', 1, 'out'],
  ["error: unknown command 'auth'", 1, 'unknown'],
  ['что-то не то', 0, 'unknown'],
  ['{"authMethod":"claude.ai"}', 0, 'unknown']
])('parseAuthStatus(%s, %s) → %s', (out, code, want) => {
  expect(parseAuthStatus(out, code)).toBe(want)
})
test('путь с пробелом и кириллицей уходит в кавычках', () => {
  expect(loginCommandLine('C:\\Users\\Иван Иванов\\.local\\bin\\claude.exe'))
    .toBe('"C:\\Users\\Иван Иванов\\.local\\bin\\claude.exe" auth login')
})
test('старый cli.js запускается через node', () => {
  expect(loginCommandLine('C:\\npm\\cli.js')).toBe('node C:\\npm\\cli.js auth login')
})
```

  Плюс:
  - `readAuthStatus`: подделка `exec` отдаёт `{ stdout: '{"loggedIn":false}', code: 1 }` → `'out'`; бросает `ENOENT` → `'unknown'`; вызвана с `[agent, ['auth','status','--json']]` и `timeout: 15000`.
  - `LoginWatch` (подделки таймеров, `now`): последовательность `out, out, in` → `onProgress` вызван `['waiting','in']`, `check` — 3 раза, после `in` таймеров нет; при `maxMs` прошедших — `'timeout'` и проверок больше нет; `start()` дважды подряд — одна петля (число `check` не удваивается); `check` бросает — считается `unknown`, опрос продолжается; следующая проверка планируется только после того, как предыдущая ответила.
  - `environment.test.ts`: `checkEnvironment` с `authStatus: async () => 'out'` → `ready: false, auth: 'out'`; с `'unknown'` → `ready: true`; без агента → `auth: null`, `authStatus` не вызван.
- [ ] **Step 2: Run** `npx vitest run tests/unit/auth.test.ts tests/unit/environment.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
  - `parseAuthStatus` берёт из JSON только `loggedIn`, если это boolean; всё остальное — `unknown`. Ненулевой код при валидном JSON не мешает (CLI выходит с 1, когда вход не выполнен).
  - `loginCommandLine`: для `.js` — `node <quoteArg(path)>`, иначе `quoteArg(path)`; затем ` auth login`. `quoteArg` — из `install.ts`.
  - `openLoginWindow`: `spawn('cmd.exe', ['/d', '/s', '/c', `"start "" cmd.exe /k "${loginCommandLine(agent)}""`], { detached: true, windowsHide: false, windowsVerbatimArguments: true }).unref()`. Внутренний `cmd /k` видит больше двух кавычек и снимает только первую и последнюю, так что путь с пробелом доходит целым. Окно остаётся открытым после входа (`/k`) — человек видит, что CLI ответил.
  - `LoginWatch` меряет время через `now` (по умолчанию `performance.now()`), не через `Date`.
  - `ipc.ts`: один `LoginWatch` на процесс; `setupLogin` находит агента через `locateAgent(settings.agentPath)`, открывает окно и вызывает `watch.start()`; `onProgress` шлёт `setupLoginProgress` в окно, на `'in'` ещё и `deps.onLoggedIn?.()`. `setupCheck` передаёт `authStatus` (фейковый при `QCLOD_FAKE_AUTH`, иначе `readAuthStatus`). Удаление `setupTerminal` убирает и его из `INVOKE_CHANNELS`.
  - `SEAM` дополняется `FAKE_AUTH` и `__qclodLoginOpens`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/auth.test.ts tests/unit/environment.test.ts tests/unit/channels.test.ts tests/unit/releaseSeams.test.ts` — PASS; `npm run typecheck` — чисто (старый `SetupScreen` ещё зовёт `openTerminal`: на этом шаге его кнопка «Открыть терминал» переводится на `login()`, остальное — Task 5).
- [ ] **Step 5: Commit** `feat: login opens claude auth login in its own window and notices success by itself`

---

### Task 5: Экран первого запуска

**Files:**
- Modify: `src/renderer/components/SetupScreen.tsx`, `src/renderer/components/SetupScreen.css`
- Modify: `src/renderer/app/App.tsx:~392-400` (настройки поверх экрана установки, перепроверка при закрытии)
- Modify: `src/renderer/components/SettingsScreen.tsx` (проп `focusField?: 'agentPath'` → `autoFocus` и `select()` поля `setting-agentPath`)
- Test: `tests/e2e/setup.spec.ts`

**Interfaces:**
- Consumes: `EnvironmentReport` с `auth` и `agent.problem` (Task 2, 4); `window.qclod.installAgent/cancelInstall/onSetupOutput` (есть); `login()`, `onLoginProgress` (Task 4); `QCLOD_FAKE_INSTALL`, `QCLOD_FAKE_AUTH`.
- Produces: `SetupScreen` props `{ report: EnvironmentReport; onRecheck: () => void; onDone: () => void; onOpenSettings: () => void }`. testid: `setup-screen`, `setup-step-agent`, `setup-step-login` (у обоих `data-state="done|active|todo|blocked"`), `setup-install`, `setup-cancel`, `setup-log`, `setup-no-method`, `setup-agent-problem`, `setup-open-settings`, `setup-login`, `setup-login-state`, `setup-recheck`, `setup-done`. `setup-agent` и `setup-terminal` уходят; тесты, которые их ищут, переписываются.

**Дизайн (по `frontend-design`, в рамках существующих токенов).** Содержание — настоящая последовательность из двух шагов, поэтому нумерация здесь оправдана, а заголовки над шагами не нужны.

- Токены: фон экрана `--surface`, карточка `--surface-raised` с `--border` и `--radius`, тень `--shadow-modal` (не `--glow-soft`: этап 3 уходит от свечения), текст `--text` / `--text-dim` / `--text-faint`, акцент `--accent` / `--on-accent`, успех `--ok`, ошибка `--danger`, шрифт `--font-ui`, моноширинный `--font-mono` — только для вывода установщика, размеры `--text-xl` (заголовок), `--text-md` (шаги), `--text-sm` (пояснения), `--text-xs` (лог), отступы `--space-*`.
- Раскладка: карточка до 600 px по центру окна, всё внутри выровнено влево.

```
 Подготовим Qclod к работе
 Qclod работает через Claude Code — вашу программу и ваш аккаунт.

 (1)─ Claude Code                      [Установить]
  │   Не установлен на этом компьютере.
  │   ┌ лог установщика, моно, до 160 px ┐
 (2)─ Вход в аккаунт                    [Войти]
      Нужно войти один раз. Откроется окно, а в нём браузер.

                         [Проверить снова] [Начать работу]
```

- Одна запоминающаяся деталь: вертикальная линия между кружками шагов заполняется `--accent` до активного шага (переход высоты `var(--dur) var(--ease)`, при `prefers-reduced-motion: reduce` — без перехода). Остальное тихо: никаких градиентов, свечения, капса, «—» в подписях.
- Кружок шага: номер; готовый — `Check` (Lucide), заблокированный — `CircleAlert`. Будущий шаг — `--text-faint`, его кнопка не показывается.
- Лог: пока идёт установка — полный; после успеха сворачивается до последней строки.
- Фокус виден у каждой кнопки (`:focus-visible`), `outline: none` не используется. Основная кнопка на экране всегда одна: та, что продвигает активный шаг; «Начать работу» становится основной, когда оба шага пройдены.

**Тексты (копировать как есть).**

| Состояние | Строка | Кнопки |
|---|---|---|
| Заголовок | «Подготовим Qclod к работе» | — |
| Подзаголовок | «Qclod работает через Claude Code — вашу программу и ваш аккаунт. Нужно два шага.» | — |
| 1, нет агента | «Не установлен на этом компьютере.» | «Установить» |
| 1, ставится | «Устанавливаю…» + лог | «Отменить» |
| 1, не вышло | «Установить не получилось. Если Claude Code у вас уже стоит, укажите путь к claude.exe в настройках.» | «Попробовать снова», «Открыть настройки» |
| 1, нечем ставить | «Нечем установить: нет ни winget, ни Node.js. Поставьте Claude Code вручную и укажите путь к claude.exe в настройках.» | «Открыть настройки» |
| 1, есть `problem` | текст `problem` | «Открыть настройки» |
| 1, готово | «Установлен, версия {version}» (без версии — «Установлен») | — |
| 2, `out` | «Нужно войти один раз. Откроется окно, а в нём браузер.» | «Войти» |
| 2, `waiting` | «Жду входа в открывшемся окне…» | «Открыть окно ещё раз» |
| 2, `timeout` | «Не дождался входа. Если вы уже вошли, нажмите «Проверить снова».» | «Войти» |
| 2, `in` | «Вход выполнен.» | — |
| 2, `unknown` | «Не удалось проверить вход. Если Claude Code попросит войти, во вкладке появится кнопка «Войти».» | — |
| Низ | — | «Проверить снова», «Начать работу» (доступна, когда агент найден) |

«Начать работу» доступна при найденном агенте даже при `auth: 'out'`: если проверка входа ошиблась, человек не застревает (анти-цель раздела 3).

- [ ] **Step 1: Write the failing e2e tests** в `tests/e2e/setup.spec.ts` (хелпер `launch` получает `extraEnv`; для фейков — `QCLOD_FAKE_INSTALL`, `QCLOD_FAKE_AUTH`):
  - `ставит, затем ведёт ко входу`: `methods:['winget'], results:[true], createAgentAt:<tmp>\\claude.exe`, `agentPath` = этот путь, `sequence:['out','out','in'], pollMs:100`. Клик `setup-install` → `setup-log` содержит `фейковая установка: winget` → `setup-step-agent[data-state=done]` → `setup-step-login[data-state=active]` → клик `setup-login` → `app.evaluate(() => globalThis.__qclodLoginOpens.length)` равно 1 → `setup-login-state` содержит «Жду входа» → затем «Вход выполнен.» → клик `setup-done` → виден `composer-input`.
  - `winget упал — поставил npm`: `results:[false,true]`, `methods:['winget','npm']` → лог содержит «пробую через npm», шаг 1 `done`.
  - `нечем ставить — ведёт в настройки`: `methods:[]` → `setup-no-method` виден → клик `setup-open-settings` → `setting-agentPath` в фокусе → ввести `process.execPath`, закрыть настройки → шаг 1 `done`.
  - `обёртка .cmd названа`: `agentPath` — временный `claude.cmd` без цели → `setup-agent-problem` содержит «.cmd-обёртка», виден `setup-open-settings`.
  - `не дождался входа`: `sequence:['out']`, `pollMs:50`, в фейке `maxMs` берётся из `QCLOD_FAKE_AUTH.maxMs: 300` → «Не дождался входа».
  - `агент есть, вход не выполнен — сразу шаг 2`: агент найден, `sequence:['out']` → экран установки виден, шаг 1 `done`, `setup-done` доступна.
  - существующие три теста переписываются на новые testid; `с установленным агентом экран установки не мешает` остаётся как есть (фейк по умолчанию `in`).
- [ ] **Step 2: Run** `npm run build:e2e && npx playwright test tests/e2e/setup.spec.ts` — FAIL.
- [ ] **Step 3: Implement** экран по таблице и дизайну выше. В `App.tsx` ранний `return <SetupScreen/>` заменяется на фрагмент из `SetupScreen` и `SettingsScreen` поверх него, когда `settingsOpen`; закрытие настроек, открытых с экрана установки, вызывает `recheck()`. Состояние шага 2 (`waiting/timeout`) живёт в `SetupScreen` из `onLoginProgress`; на `'in'` экран вызывает `onRecheck()`.
- [ ] **Step 4: Run** `npx playwright test tests/e2e/setup.spec.ts tests/e2e/settings.spec.ts` — PASS; `npm run typecheck` — чисто. Снять скриншоты всех состояний шага 1 и 2 (`win.screenshot` в `tests/.artifacts/setup-*.png`) и приложить к отчёту задачи.
- [ ] **Step 5: Commit** `feat: first-run screen installs Claude Code and walks through login`

---

### Task 6: «Войти» в новой вкладке и продолжение после входа

**Files:**
- Modify: `src/main/agent/startFailure.ts` (константа текста)
- Modify: `src/main/agent/AgentSession.ts:~994-1010` (`fail`)
- Modify: `src/main/tabs/TabController.ts` (`recoverFromDeadSession` — общий текст; `wire` — `canRetry`; новый `afterLogin`)
- Modify: `src/main/index.ts` (`registerBaseIpc({ …, onLoggedIn: () => void controller.afterLogin() })`)
- Modify: `tests/fixtures/fake-sdk/index.mjs`, `index.d.mts`, `README.md` (шаг `crash` с `times`)
- Test: `tests/unit/agentSession.test.ts`, `tests/unit/tabController.test.ts`, `tests/e2e/chat.spec.ts`

**Interfaces:**
- Produces: `export const LOGIN_NEEDED_TEXT = 'Claude Code не вошёл в аккаунт. Нажмите «Войти» — после входа вкладка продолжит сама.'` в `startFailure.ts`.
- Produces: `TabController.afterLogin(): Promise<void>` — `retry(id)` по очереди для каждой вкладки, чья сессия в `error` и `classifyStartFailure(session.error) === 'not-logged-in'`.
- Produces (фейк): `{ kind: 'crash', message: string, times?: number }` — падает первые `times` запусков, счётчик в файле `fake-sdk-crashes.json` в `process.env.QCLOD_USER_DATA`; без `times` — как сейчас.
- Consumes: `deps.onLoggedIn` (Task 4), `RibbonItem` уже зовёт `login()` (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - `agentSession`: новая сессия, фейк `crash` с `Not logged in · Please run /login` → последняя `notice` — `{ tone: 'error', action: 'login', text: LOGIN_NEEDED_TEXT }`, сырого текста ошибки в ленте нет, `session.error` по-прежнему сырой.
  - `tabController`: та же ошибка на вкладке без `lastSessionId` → `canRetry: true`; на resume-пути login-notice в ленте ровно одна (не две: от `fail` и от `recoverFromDeadSession`); `afterLogin()` вызывает новую сессию у такой вкладки и не трогает вкладку в `error` по другой причине и вкладку в `idle`.
  - e2e `chat.spec.ts` `новая вкладка без входа: Войти, и вкладка продолжает`: сценарий `crash` `times: 1`, `QCLOD_FAKE_AUTH` `{"sequence":["in"],"pollMs":50}`; отправить сообщение → виден `notice-login` → клик → в ленте появляется ответ второй сессии (шаг `text` после `crash` в сценарии), неотправленное сообщение ушло один раз.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agentSession.test.ts tests/unit/tabController.test.ts` — FAIL.
- [ ] **Step 3: Implement.** В `fail`: если `classifyStartFailure(text) === 'not-logged-in'` — `notice(LOGIN_NEEDED_TEXT, 'error', 'login')` вместо `explain(text)`. В `recoverFromDeadSession` локальная строка заменяется константой; существующая проверка `told` теперь находит notice от `fail` и второй не ставит. В `wire` `canRetry` также `true`, когда `status === 'error'` и причина `not-logged-in`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/agentSession.test.ts tests/unit/tabController.test.ts tests/unit/startFailure.test.ts tests/unit/fakeSdk.test.ts && npm run build:e2e && npx playwright test tests/e2e/chat.spec.ts` — PASS.
- [ ] **Step 5: Commit** `fix: a new tab that is not logged in offers Войти and carries on after login`

---

### Task 7: Автообновление

**Files:**
- Modify: `package.json` (`"electron-updater": "6.3.9"` в `dependencies`, без `^`)
- Create: `src/main/update/updater.ts`
- Create: `src/renderer/components/UpdateBanner.tsx`, `src/renderer/components/UpdateBanner.css`
- Modify: `src/shared/types.ts` (`UpdateState`), `src/shared/channels.ts` (`updateGet`, `updateRestart` — invoke; `updateChanged` — событие), `src/preload/index.ts`, `tests/unit/channels.test.ts`
- Modify: `src/main/index.ts` (создать и запустить после `did-finish-load`)
- Modify: `src/renderer/app/App.tsx` (одна вставка `<UpdateBanner/>` между `TitleBar` и `app-body`)
- Modify: `scripts/releaseSeams.mjs`, `tests/unit/releaseSeams.test.ts`
- Test: `tests/unit/updater.test.ts` (новый), `tests/e2e/update.spec.ts` (новый)

**Interfaces:**
- Produces: `type UpdateState = { kind: 'idle' } | { kind: 'ready'; version: string }`.
- Produces в `updater.ts`:
  - `interface UpdateSource { checkForUpdates(): Promise<unknown>; quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void; onDownloaded(cb: (version: string) => void): void; onError(cb: (err: Error) => void): void }`
  - `class UpdateFlow { constructor(deps: { source: UpdateSource; onState: (s: UpdateState) => void; log: (msg: string) => void; setTimer?: (fn: () => void, ms: number) => unknown }); start(delayMs?: number): void; readonly state: UpdateState; restart(): boolean }`; `UPDATE_FIRST_CHECK_MS = 10000`, `UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000`.
  - `createUpdateSource(isPackaged: boolean): UpdateSource | null` — фейк при `QCLOD_FAKE_UPDATE`; `null`, если не `isPackaged`; иначе `autoUpdater` из `electron-updater` (импорт внутри функции) с `autoDownload = true`, `autoInstallOnAppQuit = true`, `logger = null`.
- Produces (renderer): `restartWarning(statuses: TabStatus[]): string | null` в `UpdateBanner.tsx` (экспорт для юнит-теста).
- Produces (лазейка): `QCLOD_FAKE_UPDATE` = JSON `{ version?: string; error?: string }`; фейковый `quitAndInstall` увеличивает `globalThis.__qclodUpdateRestarts` и приложение не закрывает. В фейке первая проверка без задержки.

- [ ] **Step 1: Write the failing tests** в `tests/unit/updater.test.ts` (подделка `UpdateSource`, ручные таймеры):
  - `start` ставит первую проверку через `UPDATE_FIRST_CHECK_MS`, затем каждые `UPDATE_RECHECK_MS`.
  - `onDownloaded('0.2.0')` → `state` `{ kind:'ready', version:'0.2.0' }`, `onState` вызван один раз; после этого плановые проверки не идут.
  - **сеть/TLS:** `checkForUpdates` отвергает промис `new Error('certificate is not yet valid')` **и** источник шлёт `onError` с той же ошибкой → `state` остаётся `idle`, `log` получил строку с текстом ошибки, unhandled rejection нет (`process.on('unhandledRejection')` в тесте не срабатывает), следующая проверка запланирована.
  - `restart()` до `ready` → `false`, `quitAndInstall` не вызван; в `ready` → `true`, `quitAndInstall(true, true)`.
  - `restartWarning(['idle'])` → `null`; `restartWarning(['idle','busy'])` и `(['waiting'])` → `'Во вкладках идёт работа — перезапуск её прервёт.'`
  - `releaseSeams`: `FAKE_UPDATE`, `__qclodUpdateRestarts`.
  - e2e `update.spec.ts`: с `{"version":"9.9.9"}` виден `update-banner` с текстом «Скачана новая версия 9.9.9.»; клик `update-restart` → `__qclodUpdateRestarts === 1`; клик `update-later` прячет баннер. С `{"error":"net::ERR_INTERNET_DISCONNECTED"}` — через 3 с баннера нет, `composer-input` работает. Без переменной — баннера нет.
- [ ] **Step 2: Run** `npx vitest run tests/unit/updater.test.ts tests/unit/releaseSeams.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
  - `npm install electron-updater@6.3.9 --save-exact`.
  - `index.ts`: `const source = createUpdateSource(app.isPackaged)`; если не `null` — `UpdateFlow`, `onState` шлёт `updateChanged`, `log` — `console.warn('[update]', message)`; `start()` в `did-finish-load`. `updateGet` отдаёт `flow?.state ?? { kind: 'idle' }`, `updateRestart` — `flow?.restart() ?? false`. Выход при `quitAndInstall` идёт через `app.quit()` → существующий `before-quit` ставит `quitting = true`, поэтому «сворачивать в трей» выход не перехватывает; этот путь не менять.
  - Баннер: полоса на всю ширину под заголовком окна, `--surface-raised`, нижняя граница `--border`, текст `--text-sm`; значок `Download` (Lucide) в `--accent`. Тексты: «Скачана новая версия {version}. Перезапустите Qclod, чтобы обновиться.», под ним, если `restartWarning` не `null`, — предупреждение в `--warn`. Кнопки: «Перезапустить» (основная, testid `update-restart`), «Позже» (testid `update-later`; прячет баннер до следующего запуска, обновление всё равно поставится при выходе). Корень — `role="status"`, testid `update-banner`. Состояние берётся `updateGet` при монтировании и `onUpdateChanged` дальше; статусы вкладок — из `useAppStore`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/updater.test.ts tests/unit/channels.test.ts tests/unit/releaseSeams.test.ts && npm run build:e2e && npx playwright test tests/e2e/update.spec.ts` — PASS; `npm run build && npm run check:seams` — «лазеек нет».
- [ ] **Step 5: Commit** `feat: updates download from GitHub releases and install on restart`

---

### Task 8: Мастер установки — картинки, русский, ярлыки

Страницы NSIS остаются системными (светлые окна Windows) — без сторонних плагинов их не перекрасить. Фирменный вид несут боковая картинка приветствия и завершения и картинка в шапке внутренних страниц. Это честная граница; владельцу сказать.

**Files:**
- Create: `scripts/installerArt.mjs` (чистые функции), `scripts/make-installer-art.mjs` (CLI: пишет `build/installerSidebar.bmp`, `build/installerHeader.bmp`)
- Create: `build/installer.nsh` (UTF-8 **с BOM** — иначе NSIS прочтёт кириллицу в кодировке системы)
- Modify: `electron-builder.yml` (блок `nsis`)
- Modify: `package.json` (скрипт `"art": "node scripts/make-installer-art.mjs"`; `dist` и `dist:e2e` вызывают `npm run art` после `npm run icon`)
- Modify: `.gitignore` (`build/installerSidebar.bmp`, `build/installerHeader.bmp` — как `build/icon.png`, генерируются)
- Test: `tests/unit/installerArt.test.ts` (новый)

**Interfaces:**
- Produces в `installerArt.mjs`: `encodeBmp24(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer`; `readAccent(tokensCss: string): [number, number, number]` (берёт `--accent: #rrggbb` из `src/renderer/styles/tokens.css`, бросает, если там не hex); `drawSidebar(accent): Buffer` (164×314); `drawHeader(accent): Buffer` (150×57); `GRAPHITE = { bg: '#0f0f11', surface: '#16161a', raised: '#1d1d22', line: '#26262d' }` (значения из спеки, раздел 6).
- Акцент читается из `tokens.css`, а не копируется: этап 3 поменяет `--accent`, и картинки пойдут за ним без правки скрипта. `make-icon.mjs` не трогать (иконку, если нужно, перерисовывает этап 3).

**Картинки (по `frontend-design`).** Мотив — лента Qclod: несколько строк-полос разной длины, как реплики в чате, и одна из них в акценте — живая строка «что агент делает сейчас». Знак приложения — скруглённый квадрат в акценте, как на иконке.

```
sidebar 164×314, фон #0f0f11        header 150×57, фон #0f0f11
┌──────────────┐                    ┌──────────────────┐
│ ■            │ знак 28×28, r=7,   │ ■  ▬▬▬▬▬▬        │ знак 20×20 слева,
│              │ отступ 20          │    ▬▬▬▬ (акцент) │ три полосы 5 px
│              │                    │    ▬▬▬▬▬         │
│ ▬▬▬▬▬▬▬▬     │ полосы 6 px, r=3,  └──────────────────┘
│ ▬▬▬▬▬▬▬▬▬▬   │ шаг 14 px, x=20,
│ ▬▬▬▬▬ акцент │ ширины 96,120,72,108,56;
│ ▬▬▬▬▬▬▬▬▬    │ третья — акцент, остальные
│ ▬▬▬▬         │ #1d1d22 и #26262d через одну
└──────────────┘ нижний край блока полос — y=280
```

Без текста в картинках (NSIS пишет заголовки сам), без градиентов и свечения. Края скруглений сглажены на один пиксель (тот же приём, что `roundedRectAlpha` в `make-icon.mjs`, — функция копируется в `installerArt.mjs`, чтобы не трогать файл этапа 3).

**`build/installer.nsh` (точный текст).** Переносы строк в NSIS — `$\r$\n`.

```nsis
!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Установка Qclod"
  !define MUI_WELCOMEPAGE_TEXT "Qclod — окно для Claude Code: вкладки, история разговоров, панель с контекстом и лимитами.$\r$\n$\r$\nПрава администратора не нужны. Если Claude Code ещё не установлен, Qclod поставит его сам при первом запуске.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !define MUI_FINISHPAGE_TITLE "Qclod установлен"
  !define MUI_FINISHPAGE_TEXT "Новые версии Qclod скачает сам и предложит перезапуститься."
!macroend
```

Если сборка падает с «already defined» — обернуть каждый `!define` в `!ifdef X` / `!undef X` / `!endif` перед определением; тексты не менять.

**`nsis` в `electron-builder.yml`** — к существующим `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: true`, `createStartMenuShortcut: true`, `shortcutName: Qclod`, `artifactName` добавить:

```yaml
  uninstallDisplayName: Qclod
  installerLanguages: [ru_RU]
  language: '1049'
  multiLanguageInstaller: false
  installerSidebar: build/installerSidebar.bmp
  uninstallerSidebar: build/installerSidebar.bmp
  installerHeader: build/installerHeader.bmp
  include: build/installer.nsh
  runAfterFinish: true
  deleteAppDataOnUninstall: false
```

- [ ] **Step 1: Write the failing tests** в `tests/unit/installerArt.test.ts`:
  - `encodeBmp24(164, 314, …)`: первые байты `BM`; размер файла `54 + 492 * 314` (строка 164×3 = 492, уже кратна 4); `readInt32LE(18) === 164`, `readInt32LE(22) === 314` (положительная — строки снизу вверх), `readUInt16LE(28) === 24`; для `encodeBmp24(3, 2, …)` строка дополнена до 12 байт и пиксель `(0, 0)` (верхний левый) лежит в последней строке файла в порядке BGR.
  - `readAccent(':root { --accent: #6e8bff; }')` → `[0x6e, 0x8b, 0xff]`; `readAccent('--accent: rgba(1,2,3,1)')` бросает.
  - `drawSidebar([255,0,0])`: пиксель `(10, 10)` равен `#0f0f11`; пиксель в середине третьей полосы — `[255,0,0]`; длина буфера как выше. `drawHeader` — размер 150×57.
- [ ] **Step 2: Run** `npx vitest run tests/unit/installerArt.test.ts` — FAIL.
- [ ] **Step 3: Implement** функции, CLI, `installer.nsh`, блок `nsis`, скрипты, `.gitignore`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/installerArt.test.ts` — PASS; `npm run dist` — в `dist/` появился `Qclod-0.1.0-setup.exe` и `latest.yml`, сборка NSIS без ошибок, `check:seams` — «лазеек нет». Мастер глазами проверяет владелец (пункт чек-листа в Task 10); исполнитель установщик не запускает.
- [ ] **Step 5: Commit** `build: Russian installer wizard with graphite artwork`

---

### Task 9: Выпуск через GitHub Actions по тегу

**Files:**
- Create: `scripts/releaseTag.mjs` (`tagMatchesVersion`), `scripts/check-release-tag.mjs` (CLI)
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (скрипты)
- Test: `tests/unit/releaseTag.test.ts` (новый)

**Interfaces:**
- Produces: `tagMatchesVersion(tag: string, version: string): boolean` — `true` только для `v${version}` ровно.
- Produces: скрипт `release` = `npm run icon && npm run art && npm run build && npm run check:seams && electron-builder --win --x64 --publish always`. `dist` и `dist:e2e` получают `--publish never` в конце (иначе на CI с тегом electron-builder сам решит публиковать).

- [ ] **Step 1: Write the failing test:** `tagMatchesVersion('v0.2.0','0.2.0') === true`; `('0.2.0','0.2.0')`, `('v0.2.1','0.2.0')`, `('v0.2.0-beta','0.2.0')` — `false`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/releaseTag.test.ts` — FAIL.
- [ ] **Step 3: Implement.** CLI читает `RELEASE_TAG` и `package.json`, при несовпадении пишет в stderr `тег ${tag} не совпадает с версией ${version} в package.json` и выходит с 1. Workflow (точный текст):

```yaml
name: release
on:
  push:
    tags: ['v*.*.*']
permissions:
  contents: write
jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: node scripts/check-release-tag.mjs
        env:
          RELEASE_TAG: ${{ github.ref_name }}
      - run: npm run typecheck
      - run: npm run release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

  Юнит- и e2e-тесты в workflow не идут: часть юнит-тестов опирается на настоящий `claude` и `winget` машины владельца, а на раннере их нет. Тесты прогоняются локально по чек-листу перед тегом (Task 10). `GITHUB_TOKEN` — встроенный, других секретов нет. Релиз создаётся сразу опубликованным (`releaseType: release` из Task 1) и несёт `Qclod-X.Y.Z-setup.exe`, `.blockmap`, `latest.yml` и портативный `Qclod.exe`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/releaseTag.test.ts tests/unit/buildConfig.test.ts` — PASS; `RELEASE_TAG=v0.1.0 node scripts/check-release-tag.mjs` — код 0; `RELEASE_TAG=v9.9.9 node scripts/check-release-tag.mjs` — код 1 и текст. `npm run dist` по-прежнему собирает, ничего не публикуя.
- [ ] **Step 5: Commit** `build: release workflow publishes the installer on a version tag`

---

### Task 10: README для друзей и чек-лист выпуска

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/checklists/release-smoke.md`

**Interfaces:** — (документы). Ссылки: `https://github.com/SOJuse/qclod/releases/latest`.

**README** — простым русским, без рекламы и общих слов, разделы ровно такие:
1. Что это — одна-две фразы: окно для Claude Code на Windows; нужна подписка Claude (Pro/Max) или ключ API.
2. Как поставить — скачать `Qclod-X.Y.Z-setup.exe` со страницы релизов, запустить.
3. Если Windows ругается — «Windows защитил ваш компьютер»: нажать «Подробнее», затем «Выполнить в любом случае». Почему: у установщика нет платной подписи, файл собирается на GitHub из этого репозитория.
4. Первый запуск — Qclod сам поставит Claude Code и откроет окно входа; что делать, если не получилось (кнопка «Открыть настройки», путь к `claude.exe`).
5. Обновления — приходят сами, Qclod предложит перезапуститься. Портативный `Qclod.exe` сам не обновляется — его качают заново.
6. Как удалить — «Параметры → Приложения». Переписки остаются в Claude Code, Qclod их не хранит.
7. Для разработки — `npm ci`, `npm run dev`, `npm run dist`; выпуск: поднять `version` в `package.json`, коммит, `git tag vX.Y.Z`, `git push --tags`.
Автор — `SOJuse`. Почты нет.

**Чек-лист** — в разделе «Установка и первый запуск на чужой машине»:
- заменить «Кнопка «Открыть терминал» запускает `claude`…» на: «**Вход.** «Войти» открывает окно с `claude auth login`; после входа в браузере экран сам пишет «Вход выполнен.», без перезапуска. Путь к `claude.exe` с пробелом в имени пользователя — окно тоже открывается.»
- добавить: «**Мастер установки** по-русски: приветствие с боковой картинкой, выбор папки, ярлыки на рабочем столе и в «Пуске», в конце — «Запустить Qclod».»; «**winget сломан** (отключить источник `winget source disable winget`): установка сама переходит на npm.»; «**Новая вкладка без входа** (после `claude auth logout`): кнопка «Войти», после входа вкладка продолжает и отправляет то, что вы написали.»; «**SmartScreen**: на машине без Qclod установщик из релиза предупреждает, «Подробнее → Выполнить в любом случае» ставит.»
- новый раздел «Обновление» перед «Результат прогона»: «Поставить версию N из релиза, выпустить N+1 тегом, открыть N: через ~10 с баннер «Скачана новая версия…»; «Перезапустить» при работающем агенте предупреждает, ставит N+1 и открывает Qclod со всеми вкладками; при включённом «сворачивать в трей» приложение не остаётся в трее.»; «С выключенной сетью Qclod запускается и работает, баннера нет.»; «Перед тегом: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e` зелёные локально — workflow их не гоняет.»
- строка «`/remote-control` помечена недоступной» остаётся (её снимает этап 5).

- [ ] **Step 1: Write the check first** — `tests/unit/buildConfig.test.ts` дополняется: `README.md` существует, содержит «Выполнить в любом случае» и `SOJuse/qclod/releases`, не содержит `sojuse` и `@` с доменом; `release-smoke.md` содержит «claude auth login» и не содержит «Открыть терминал».
- [ ] **Step 2: Run** `npx vitest run tests/unit/buildConfig.test.ts` — FAIL.
- [ ] **Step 3: Write** README и правки чек-листа по пунктам выше.
- [ ] **Step 4: Run** `npx vitest run tests/unit/buildConfig.test.ts` — PASS; затем полный `npm run typecheck && npm run test:unit && npm run test:e2e` — зелено.
- [ ] **Step 5: Commit** `docs: README for friends and the release checklist for winget, login and updates`

---

## После плана (не задачи, делает контроллер с владельцем)

- Создать публичный `SOJuse/qclod`, проверить историю на секреты и личные данные (спека, раздел 7), переписать авторов коммитов на `SOJuse`, push.
- Первый релиз: `version` → `0.2.0`, тег `v0.2.0`, проверить, что релиз опубликован (не черновик) и в нём есть `latest.yml`.
- Пройти чек-лист `release-smoke.md` и показать мастер и первый запуск владельцу.
