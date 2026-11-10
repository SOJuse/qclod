# Qclod v3 — Этап 2: чат и взаимодействие. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По чату сразу видно, что делает агент и его подагенты; команды — списком над полем ввода, пути кликабельны, выбор модели/усилия/режима сохраняется, контекст и лимиты всегда на виду, а вставка картинок, фоновые задачи, история ввода и очередь работают не хуже терминала.

**Architecture:** Ядро не меняется: SDK в главном процессе, `AgentSession` на вкладку, `RibbonBuilder` превращает поток SDK в ленту, `PanelCollector` — в живые данные вкладки (`PanelData` с ревизиями). Этап расширяет обе модели данными, которые SDK уже отдаёт (вход инструмента, `tool_use_result`, события фоновых задач, `kind` строк контекста), а вид строит поверх чистых функций (`toolCategory`, `toolView`, `nowActivity`, `findPathCandidates`, `contextSegments`), которые покрыты юнит-тестами. Очередь сообщений и фоновые задачи живут в главном процессе и доходят до окна тем же каналом панели. Все новые компоненты красятся только токенами из `tokens.css`: этап 3 меняет значения токенов, а не компоненты.

**Tech Stack:** Electron 33, electron-vite 2, React 18, TypeScript 5, zustand 5, `@anthropic-ai/claude-agent-sdk` 0.3.319, `lucide-react` **1.62.0** (новая зависимость, точная версия), Vitest 2, Playwright (`_electron`) против `tests/fixtures/fake-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md` — раздел 5 целиком (5.1–5.7) и требование раздела 6 об обязательных дизайн-скиллах. Плюс три хвоста этапа 1 из `.superpowers/sdd/2026-11-10-qclod-v3-stage1-bugs/progress.md` (Task 2e, 2f, 2).

## Global Constraints

- Платформа — только Windows 11 x64.
- **Каждая задача начинается с падающего теста** (юнит или e2e против фейкового SDK). Шаг «прогнать, убедиться что падает» не пропускается; тест, который не падает на текущем коде, переписывается.
- Сквозные тесты — только против `tests/fixtures/fake-sdk`, никогда против настоящего агента. Фейк расширяется там, где задаче нужно новое поведение, и в его `README.md` дописывается строка о каждом новом шаге.
- Формы сообщений, входов и выходов инструментов берутся из `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` и `sdk-tools.d.ts`. Поля не придумываются. Сверка приведена ниже в «Сверке с SDK».
- Весь текст для пользователя — по-русски, просто, без воды. Обращение — как в остальном приложении (на «вы» или без местоимения); в живой строке — «Ждёт ответа», без «твоего/вашего».
- Цвета, размеры шрифта, отступы и радиусы в CSS новых и изменённых компонентов — **только через `var(--…)`** из `src/renderer/styles/tokens.css`. Если нужного токена нет, он добавляется в `tokens.css` в той же задаче. Захардкоженный hex в CSS компонента ревьюер возвращает.
- Иконки — только `lucide-react@1.62.0` (`"lucide-react": "1.62.0"` в `dependencies`, без `^`). Новые Unicode-глифы как иконки (`📎`, `▸`, `✎`, `⬡` и т.п.) не добавляются; те, что задача трогает, заменяются на Lucide.
- Цвет категории никогда не единственный носитель смысла: рядом всегда значок и название (правило dataviz «status/identity never color alone»). Текст красится текстовыми токенами (`--text`, `--text-dim`), цвет категории — только значок и полоска слева.
- Qclod не трогает учётные данные и не пишет файлы настроек пользователя/проекта. Новое состояние — только в `tabs.json` / `settings.json` Qclod и в `userData/pastes`.
- `bypassPermissions` никогда не сохраняется в `tabs.json`, не становится значением по умолчанию и не наследуется новой вкладкой (спека 5.4).
- В сообщениях коммитов **нет** подписей соавторов и упоминаний Claude/ИИ. Сообщения короткие, в стиле истории: `feat: …`, `fix: …`.
- Итоговое ревью этапа 1 дочищено коммитами `9169d4a` и `f5ce04f` (`TabController.ts`, `AgentSession.ts`, `ribbon.ts`); остаточные гонки — Task 0. Перед задачей, которая трогает эти файлы, — `git log -3 -- <файл>` и правка поверх свежего кода; номера строк в плане ориентировочные.
- Порядок: Task 0, затем 1–23 по номерам.
- Ветка — `feat/qclod-v2`. Команды проверки: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`. Один файл e2e: `npm run build:e2e && npx playwright test tests/e2e/<file>.spec.ts`.

## Сверка с SDK (0.3.319)

| Что нужно | Где в SDK | Вывод для плана |
|---|---|---|
| Структурный выход инструмента | `user`-сообщение с `tool_result` несёт рядом `tool_use_result` (уже читается в `ribbon.ts` для `Agent`) | Храним его на карточке как `output` |
| Bash | `BashInput {command, description?, run_in_background?, timeout?}`; `BashOutput {stdout, stderr, interrupted, backgroundTaskId?, returnCodeInterpretation?, …}` | **Кода выхода в SDK нет.** Показываем «готово»/«ошибка» по `is_error`, `returnCodeInterpretation`, если есть, и время, измеренное нами. stdout/stderr — раздельно из `BashOutput` |
| Edit / Write | `FileEditOutput {filePath, structuredPatch[{oldStart,oldLines,newStart,newLines,lines}], originalFile, …}`, `FileWriteOutput {type:'create'\|'update', filePath, content, structuredPatch, originalFile}` | Дифф — из `structuredPatch`; `originalFile` отбрасываем (может быть мегабайты) |
| Read | `FileReadOutput {type:'text', file:{filePath, content, numLines, startLine, totalLines}}` и `type:'image'` с base64 | Превью — первые строки `content`; base64 картинки отбрасываем |
| Grep / Glob | `GrepOutput {mode?, numFiles, filenames, content?, numMatches?, numLines?}`, `GlobOutput {numFiles, filenames, truncated, totalMatches?}` | Список совпадений — `filenames`/`content` |
| WebFetch / WebSearch | `WebFetchOutput {url, code, codeText, bytes, result, durationMs}`, `WebSearchOutput {query, results:(string\|{tool_use_id, content:[{title,url}]})[]}` | Заголовки результатов из `content[]` |
| Agent | `AgentInput {description, prompt, subagent_type?, run_in_background?}`; `AgentOutput` (`completed`: `content[{type:'text',text}]`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`) | Полный отчёт подагента — из `content[].text` |
| TodoWrite | `TodoWriteInput.todos[{content, status, activeForm}]` | В `TodoItem` добавляется `activeForm` |
| AskUserQuestion | `questions[1..4]{question, header, options[2..4]{label, description, preview?}, multiSelect}`; ответ — `answers: {[question]: string}` | Отвечаем на **все** вопросы; для `multiSelect` — подписи через «, » |
| Фоновые задачи | `system/task_started {task_id, tool_use_id?, description, task_type?, is_backgrounded?, ambient?, skip_transcript?}`, `system/task_notification {task_id, tool_use_id?, status:'completed'\|'failed'\|'stopped', output_file, summary}`, `system/task_updated {task_id, patch:{status?…}}`, `system/background_tasks_changed {tasks:[{task_id, task_type, description, ambient?}]}` — «REPLACE semantics» | Список задач — из этих событий; `ambient`/`skip_transcript` и `task_type: 'local_agent'` не показываем (подагенты — в своих карточках) |
| Остановить задачу | `Query.stopTask(taskId): Promise<void>` (типизирован) | Кнопка «Остановить» |
| Живой вывод | Запрос `get_task_output {task_id}` → `{output, total_bytes, truncated}` (последние 8 КиБ) описан в `sdk.d.ts:4400-4425`; метод `getTaskOutput(taskId)` **есть в `sdk.mjs`, но не в типах `Query`** | Вызываем через проверку `typeof q.getTaskOutput === 'function'`; нет метода — пишем «Вывод недоступен в этой версии Claude Code». Это **пробел SDK**, отмечен по требованию спеки 5.7 |
| Команды | `SlashCommand {name, description, argumentHint, aliases?, builtin?}` из `supportedCommands()` | Источник списка не меняется |
| Картинка в сообщении | `{type:'image', source:{type:'base64', media_type, data}}` — уже так в `sdkDriver.toSdkMessage` | Меняется только подготовка картинки (размер) и показ |
| Сжатие | Метода `compact` у `Query` нет | «Сжать сейчас» отправляет сообщение `/compact` |
| Строки контекста | `SDKContextUsageCategory {name, tokens, kind:'used'\|'free'\|'buffer'\|'deferred'}` | `kind` доезжает до окна; `deferred` не рисуем |
| Время инструмента | `tool_progress {tool_use_id, elapsed_time_seconds}` | Не нужен: время меряем от карточки до результата |

## Решения по виду (frontend-design + dataviz)

Этап 3 перекрасит приложение целиком; этот этап закладывает **структуру и токены**, на которые он ляжет. Решения ниже приняты по `frontend-design` (сначала токены и раскладка, потом код; одна запоминающаяся деталь, остальное тихо) и `dataviz` (форма по задаче данных, цвета проверены валидатором, статусные цвета зарезервированы).

**Запоминающаяся деталь — живая строка «сейчас»** над полем ввода: значок категории, глагол прозой, объект моноширинно, таймер. Всё остальное — спокойное: карточки нейтральные, цвет категории только на значке и 2px полоске слева, без заливок и теней.

**Раскладка нижней части чата** (снизу вверх — от самого частого к реже нужному):

```
│ … лента …                                                         │
├───────────────────────────────────────────────────────────────────┤
│ ▌[⌘] Запускает  npm test                        0:42   2 агента ▴ │  NowLine
│  [☑] Задачи 3/7  Пишет тесты для парсера                        ▴ │  TodoStrip
│  В очереди: «и потом закоммить»                                 × │  QueueStrip
│  [!] Контекст почти заполнен — 92%                 [Сжать сейчас] │  ContextBanner (≥90%)
│ ┌ список / команд или @ файлов всплывает здесь, над полем ┐       │  InlineMenu
│ [📎] Что делаем?                                             [↑]  │  Composer
│  План ▾   Opus 5 ▾   high ▾        ▬▬▬▭ 42%   5 ч 13%   нед 38%  Фоновые 2 │  StatusLine
```

Выравнивание — по левому краю поля ввода; строка статуса делится на две группы (переключатели слева, индикаторы справа) промежутком, а не разделителями « · ».

**Токены, которые добавляет этап 2** (значения — для нынешнего тёмного фона; этап 3 может сдвинуть ступени, но не роли):

| Токен | Значение | Роль |
|---|---|---|
| `--cat-read` | `#8b93a7` | Чтение — нейтральный сланцевый (спека: «нейтральный/голубой»), 5.9:1 к `#16161a` |
| `--cat-search` | `#22a0c8` | Поиск — бирюзово-голубой |
| `--cat-edit` | `#4aa43c` | Правка — зелёный |
| `--cat-command` | `#c47c10` | Команда — янтарный |
| `--cat-agent` | `#8f7cf0` | Агент — фиолетовый |
| `--cat-mcp` | `#dc5c98` | MCP — розовый |
| `--cat-plan` | `var(--accent)` | План/вопрос — акцент |
| `--cat-other` | `var(--text-faint)` | Прочее |
| `--status-ok` / `--status-warn` / `--status-critical` | `#0ca30c` / `#fab219` / `#e5484d` | Зарезервированы: индикатор контекста, ошибки. Никогда не цвет категории |
| `--meter-track` | `#26262d` | Пустая часть индикаторов |
| `--seg-1`…`--seg-6` | `#3987e5 #d95926 #199e70 #c98500 #d55181 #9085e9` | Полоса разбивки контекста (категориальная палитра dataviz, тёмные ступени) |
| `--seg-free` / `--seg-buffer` | `var(--meter-track)` / штриховка `repeating-linear-gradient(135deg, …)` | Свободно / резерв сжатия |
| `--font-ui` | `'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif` | Проза и интерфейс новых компонентов (этап 3 поставит Inter/Geist Sans) |
| `--text-xs` `--text-sm` `--text-md` `--text-lg` `--text-xl` | `11px 12px 13px 15px 18px` | Шкала из пяти ступеней вместо случайных размеров |
| `--space-1`…`--space-5` | `4px 8px 12px 16px 24px` | Отступы |
| `--rule-category` | `2px` | Ширина полоски категории |

**Проверка цветов валидатором dataviz** (`validate_palette.js`, тёмный режим, фон `#16161a`, затем `#1d1d22`):
- Пять оттенков категорий `#22a0c8,#4aa43c,#c47c10,#8f7cf0,#dc5c98`, все пары: светлота в полосе, хрома выше порога, контраст ≥ 3:1, **порог различимости для нормального зрения пройден** (худшая пара фиолетовый↔голубой ΔE 15.5). Порог для дальтоников по всем парам **не пройден** (зелёный↔янтарный ΔE 3.9 у дейтеранопов) — пять оттенков «все со всеми» его не проходят ни при каком подборе. Поэтому значок и название обязательны (Global Constraints), а у правок есть ещё и «+12 −3».
- Палитра полосы контекста `--seg-1…6` по соседним парам: все проверки PASS (худший CVD ΔE 8.4, нормальное зрение 19.3).
- Чтение (`--cat-read`) нарочно низкохромное: оно самое частое и должно быть фоном, а не сигналом.

**Формы данных (dataviz «choosing a form»):**
- Контекст и лимиты в строке статуса — **meter**: тонкая полоска 48×6px со скруглёнными концами, заливка по тяжести (`--accent` → `--status-warn` ≥ 80% → `--status-critical` ≥ 90%), пустая часть — `--meter-track`, число рядом текстовым токеном. Подсказка (`title`) даёт точные числа и время сброса. Кольцо не берём: на 48px оно читается хуже полоски.
- Разбивка контекста в боковой панели — **тонкая сегментированная полоса** 8px: доли пропорциональны токенам, 2px зазор цвета фона между частями, свободное — трек, резерв — штриховка. Под ней — легенда-таблица в порядке частей: образец цвета, имя, токены (это и есть «табличный вид»). Цвет следует за строкой, а не за её рангом: слот присваивается по порядку строк, который отдаёт CLI, седьмая и дальше складываются в «Другое».
- Предупреждения ≥ 80/90% — значок `CircleAlert` + текст, не только цвет.

**Пересмотр против шаблона.** Первый вариант — залитые цветом карточки по категориям и цветной текст имени инструмента — это «радуга карточек», типовой SaaS-набор, и он нарушает правило dataviz «текст в текстовых токенах». Заменено на нейтральные карточки с полоской и значком. Второй вариант строки статуса — плашки «Модель: Opus · Усилие: high · …» через точки — это шаблонная мета-строка; заменено на группы с промежутком и подписи-значения без префиксов (подпись — в `title`). Капслок-ярлыков нет нигде.

## Review Focus

Случаи, которые спека подразумевает, но обычные тесты задач не ловят. Тест на каждый добавлен в задачу-владельца.

1. **Агент написал путь к `setup.exe` / `deploy.bat` / `.ps1` / `.lnk`.** Клик не запускает программу: такой путь открывается как «Показать в проводнике». → Задача 10.
2. **Путь вида `\\server\share\x.txt` (UNC) или `\\?\…`.** Не проверяется на диске и не подсвечивается: `stat` UNC-пути — это сетевой запрос и утечка NTLM-хеша на чужой сервер. → Задача 10.
3. **Ctrl+W на вкладке, где агент работает.** Не убивает работу одним случайным нажатием: первое нажатие показывает «Агент работает — Ctrl+W ещё раз закроет вкладку», второе в течение 3 с закрывает. → Задача 7.
4. **Сообщение в очереди, а сессия упала.** Сообщение не теряется и не уходит в мёртвую сессию: остаётся в очереди, «Запустить заново» отправляет его новой сессии. → Задача 21.
5. **Огромный вывод: `Read` файла на 5 МБ, `Bash` с мегабайтом stdout.** Карточка хранит не больше 20 000 символов на строковое поле, раскрытие не вешает окно, «показать всё» показывает сохранённое, а не просит больше. → Задача 8.

---

### Task 0: Остаточные гонки этапа 1 — подмена сессии, Стоп, повтор, причина ошибки

Из итогового ревью этапа 1 (после `f5ce04f`). Первой, потому что трогает те же `TabController.ts` и `AgentSession.ts`, на которых стоят Task 2, 4 и 21. Перед началом перечитать оба файла: `restart` (~:236), `resume` (~:367), `recoverFromDeadSession` (~:405), `interrupt`/`cancelWaits`/`deliver` (~:494-545).

**Files:**
- Modify: `src/main/tabs/TabController.ts` (`replacing`, `ensureSession`, `restart`, `recoverFromDeadSession`, `resume`, новый `retry`), `src/main/agent/AgentSession.ts` (номер хода у ожиданий, `interrupt`), `src/main/agent/startFailure.ts` (новый), `src/shared/types.ts` (`TabState.canRetry?`, у `notice` — `action?: 'login' | 'retry'`), `src/shared/channels.ts` (`tabsRetry 'tabs:retry'`), `src/main/agentIpc.ts`, `src/preload/index.ts`, `src/renderer/components/Composer.tsx` (полоса `composer-dead`), `src/renderer/components/RibbonItem.tsx` (кнопка у `notice`)
- Test: `tests/unit/tabController.test.ts`, `tests/unit/agentSession.test.ts`, `tests/unit/startFailure.test.ts`, `tests/unit/channels.test.ts`

**Interfaces:**
- Produces:
  - (a) `TabController.replacing: Set<TabId>` — `restart` и `recoverFromDeadSession` кладут `id` **до** `await manager.close(id)` и убирают после того, как сами создали и запустили новую сессию (в `finally`). `ensureSession(id)` при `replacing.has(id)` сразу выходит: сессию даст тот, кто подменяет. После `close` оба ещё раз проверяют `manager.get(id)` — если сессия уже есть, ничего не создают.
  - (b) У каждого ожидания (вопрос, разрешение, план) — номер хода `turn`, на котором оно открыто; `deliver()` увеличивает `this.turn`. `interrupt()` запоминает `const stopped = this.turn`; после `await driver.interrupt()` вторая уборка — `cancelWaits({ upTo: stopped })` (только ожидания с `turn <= stopped`), `turnRunning = false` и `setStatus('idle')` — только если `this.turn === stopped`. Сообщение, отправленное, пока прерывание в пути, держит свой ход и свой первый вопрос.
  - (c) `TabState.canRetry?: boolean` — `true`, когда сессия вкладки в `error`, ни разу не запустила агента (`launched === false`) и у вкладки есть `lastSessionId`. `TabController.retry(id): Promise<void>` — закрывает сессию и зовёт `ensureSession(id)` **с сохранённым** `lastSessionId` (в отличие от `restart`, который его удаляет). IPC `tabsRetry`, preload `retryTab(id)`. Полоса `composer-dead`: при `canRetry` — главная кнопка `composer-retry` «Повторить» и вторая `composer-restart` «Начать заново»; иначе как сейчас.
  - (d) `classifyStartFailure(message: string): 'missing-conversation' | 'not-logged-in' | 'other'` в `startFailure.ts`: `/no conversation found|session .* not found/i` → missing; `/not logged in|please run \/login|invalid api key|authentication_error|unauthorized/i` → not-logged-in; иначе other. `recoverFromDeadSession` подменяет сессию **только** при `missing-conversation` с прежним текстом «Прошлую переписку открыть не удалось: …». При `not-logged-in` сессия не подменяется (чистая умерла бы так же), вкладка остаётся в `error` с `canRetry`, в ленте — `notice` «Claude Code не вошёл в аккаунт. Войдите и нажмите «Повторить».» с `action: 'login'` → кнопка «Войти» зовёт `window.qclod.openTerminal()` (тот же вход, что на экране установки). При `other` — подмена, как сейчас, но текст «Сессия не запустилась: …».

- [ ] **Step 1: Падающие тесты**

```ts
// tabController.test.ts — manager.close возвращает отложенный промис, который тест решает сам
test('activate во время восстановления не открывает мёртвую переписку второй раз', async () => {
  // resume падает до init → recoverFromDeadSession ждёт close; в это время controller.activate(id)
  // → после решения close: manager.create вызван ровно 1 раз для свежей сессии,
  //   ни одного start(resumeId) с мёртвым id после первого, resend — только в свежую
})
test('activate во время restart не возвращает старую переписку', async () => {
  // restart ждёт close; activate(id) → новая сессия стартует без resume, create — 1 раз
})
test('«Повторить» после ненайденного агента открывает ту же переписку', async () => {
  // resolveAgent бросает AgentNotFoundError → tab.canRetry === true, lastSessionId на месте;
  // resolveAgent теперь находит → controller.retry(id) → start вызван с тем же resumeId
})
test('«Не вошёл в аккаунт» до init: сессия не подменяется, есть «Войти» и «Повторить»', async () => {
  // поток падает до init с 'Not logged in · Please run /login'
  // → create не вызван второй раз; notice с action 'login'; текста «Прошлую переписку» нет; canRetry
})
test('ненайденная переписка — прежнее восстановление и прежний текст', async () => {})
// agentSession.test.ts — driver.interrupt возвращает отложенный промис
test('сообщение, отправленное пока прерывание в пути, не теряет ход и свой вопрос', async () => {
  // interrupt() не дождались; send('дальше'); фейк спрашивает вопрос в новом ходе;
  // решить interrupt → вопрос всё ещё ждёт (status 'waiting'), answerQuestion уходит в updatedInput
})
// startFailure.test.ts
test.each([
  ['No conversation found with session ID: abc', 'missing-conversation'],
  ['Not logged in · Please run /login', 'not-logged-in'],
  ['Invalid API key · Fix external API key', 'not-logged-in'],
  ['spawn ENOENT', 'other']
])('%s → %s', (m, kind) => expect(classifyStartFailure(m)).toBe(kind))
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/tabController.test.ts tests/unit/agentSession.test.ts tests/unit/startFailure.test.ts`
Expected: FAIL — двойной `create`/resume, вопрос нового хода отклонён, `retry` и `classifyStartFailure` нет, текст про переписку на «Not logged in».

- [ ] **Step 3: Реализация** — по Interfaces. Тексты ошибок для `classifyStartFailure` сверить с тем, что реально приходит в `dead.error` (через `explain()` в `AgentSession`): классифицировать сырой текст до `explain`, если `explain` его меняет.

- [ ] **Step 4: Прогнать юнит целиком и e2e истории**

Run: `npx vitest run && npm run typecheck && npm run build:e2e && npx playwright test tests/e2e/history.spec.ts tests/e2e/resumedPanel.spec.ts`
Expected: PASS, без «Unhandled Rejection».

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "fix: no double resume while a session is replaced, Stop keeps a newer turn, retry and honest start errors"
```

---

### Task 1: Токены, категории действий и значки

Основа для всех задач с видом: категории инструментов (спека 5.3), их цвета и значки, шкала шрифтов и отступов.

**Files:**
- Create: `src/shared/toolCategory.ts`, `src/renderer/ui/icons.tsx`
- Modify: `src/renderer/styles/tokens.css`, `package.json`, `package-lock.json`
- Test: `tests/unit/toolCategory.test.ts`, `tests/unit/tokens.test.ts`

**Interfaces:**
- Produces:
  - `type ToolCategory = 'read' | 'search' | 'edit' | 'command' | 'agent' | 'mcp' | 'plan' | 'other'`
  - `toolCategory(name: string): ToolCategory`
  - `CATEGORY_LABEL: Record<ToolCategory, string>` — «Чтение», «Поиск», «Правка», «Команда», «Агент», «MCP», «План», «Инструмент»
  - `mcpParts(name: string): { server: string; tool: string } | null` — `mcp__srv__a__b` → `{ server: 'srv', tool: 'a__b' }`
  - `CATEGORY_ICON: Record<ToolCategory, LucideIcon>` и `ERROR_ICON` в `icons.tsx`; компонент `CategoryIcon({ category, error, size = 14 }: { category: ToolCategory; error?: boolean; size?: number }): JSX.Element` — значок цвета `var(--cat-<category>)` или `var(--status-critical)` при `error`, `aria-hidden`.
  - Токены из таблицы «Решения по виду».

Значки: read `FileText`, search `Search`, edit `FilePenLine`, command `SquareTerminal`, agent `Bot`, mcp `Plug`, plan `ListChecks`, other `Wrench`, ошибка `CircleAlert`. Все проверены в `lucide-react@1.62.0` (`dist/lucide-react.d.ts`).

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/toolCategory.test.ts
test.each([
  ['Read', 'read'], ['Glob', 'read'], ['LS', 'read'], ['NotebookRead', 'read'],
  ['Grep', 'search'], ['WebSearch', 'search'], ['WebFetch', 'search'], ['ToolSearch', 'search'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Bash', 'command'], ['PowerShell', 'command'], ['Monitor', 'command'], ['TaskStop', 'command'],
  ['Agent', 'agent'], ['Task', 'agent'],
  ['mcp__github__create_issue', 'mcp'],
  ['TodoWrite', 'plan'], ['AskUserQuestion', 'plan'], ['ExitPlanMode', 'plan'], ['EnterPlanMode', 'plan'],
  ['Skill', 'other'], ['', 'other']
])('%s → %s', (name, category) => expect(toolCategory(name)).toBe(category))

test('mcpParts берёт сервер и всё после него', () => {
  expect(mcpParts('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
  expect(mcpParts('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
  expect(mcpParts('Read')).toBeNull()
})
```

```ts
// tests/unit/tokens.test.ts — читает src/renderer/styles/tokens.css как текст
test('у каждой категории есть цветовой токен', () => {
  for (const c of ['read','search','edit','command','agent','mcp','plan','other']) {
    expect(css).toMatch(new RegExp(`--cat-${c}:`))
  }
})
test('статусные цвета, трек, сегменты, шкала шрифта и отступов на месте', () => {
  for (const t of ['--status-ok','--status-warn','--status-critical','--meter-track',
    '--seg-1','--seg-6','--seg-free','--seg-buffer','--font-ui',
    '--text-xs','--text-sm','--text-md','--text-lg','--text-xl','--space-1','--space-5','--rule-category']) {
    expect(css).toContain(`${t}:`)
  }
})
test('lucide-react закреплён точной версией', () => {
  expect(pkg.dependencies['lucide-react']).toBe('1.62.0')
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/toolCategory.test.ts tests/unit/tokens.test.ts`
Expected: FAIL — модуля нет, токенов нет, зависимости нет.

- [ ] **Step 3: Зависимость и токены**

`npm install --save-exact lucide-react@1.62.0`. Добавить токены в `:root` файла `tokens.css` со значениями из таблицы; старые токены не трогать (их чистит этап 3).

- [ ] **Step 4: `toolCategory.ts` и `icons.tsx`**

Классификация — таблица регулярных выражений по спеке 5.3 плюс `Monitor`, `TaskStop`, `KillShell`, `BashOutput` в «команды». Ошибка — не категория, а состояние карточки.

- [ ] **Step 5: Прогнать — проходит, типы чистые**

Run: `npx vitest run tests/unit/toolCategory.test.ts tests/unit/tokens.test.ts && npm run typecheck`
Expected: PASS, 0 ошибок.

- [ ] **Step 6: Коммит**

```bash
git add package.json package-lock.json src/renderer/styles/tokens.css src/shared/toolCategory.ts src/renderer/ui/icons.tsx tests/unit/toolCategory.test.ts tests/unit/tokens.test.ts
git commit -m "feat: action categories with colour tokens and lucide icons"
```

---

### Task 2: Опрос MCP не умирает навсегда (хвост 2f)

**Files:**
- Modify: `src/main/agent/AgentSession.ts` (`refreshMcp`, `pollMcpWhileWaiting`, `onInit`, ветки `commands_changed`/`plugin_install` в `onMessage`)
- Test: `tests/unit/agentSession.test.ts`

**Interfaces:**
- Consumes: `MCP_POLL_MAX`, `mcpPollMs` из опций (есть).
- Produces: поведение — счётчик `mcpPolls` обнуляется на каждом внешнем поводе (`init`, `commands_changed`, `plugin_install`); отказ `mcpServerStatus()` считается «ещё ждём» и опрос продолжается в пределах лимита, а панель сохраняет прежний список.

- [ ] **Step 1: Падающие тесты** (как тест опроса из 2f: `mcpServerStatus` — `vi.fn`, `mcpPollMs: 5`)

```ts
test('после исчерпания лимита новый init снова запускает опрос', async () => {
  // mcpServerStatus всегда отвечает pending → после MCP_POLL_MAX вызовов опрос стоит;
  // session.handle({type:'system', subtype:'init', session_id:'s'}) → вызовы продолжаются
  // (число вызовов растёт ещё как минимум на 2)
})
test('commands_changed и plugin_install тоже сбрасывают счётчик', async () => { /* то же для обоих */ })
test('временный отказ mcpServerStatus не останавливает опрос и не стирает список', async () => {
  // ответы: [pending], reject, [connected]
  // → панель: pending, затем (после отказа) всё ещё pending, затем connected
  expect(session.panel.mcp).toEqual([{ name: 'srv', status: 'connected' }])
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/agentSession.test.ts -t "опрос|отказ mcpServerStatus"`
Expected: FAIL — после лимита вызовов нет; после отказа опрос стоит.

- [ ] **Step 3: Исправить**

`refreshMcp(reason: 'poll' | 'trigger' = 'trigger')`: для `'trigger'` — `mcpPolls = 0` перед запросом. Отказ: не `[]`, а «прежний список, ждём» → `pollMcpWhileWaiting(this.collector.data.mcp, { failed: true })`, где `failed` продолжает опрос, если лимит не исчерпан. Таймер зовёт `refreshMcp('poll')`.

- [ ] **Step 4: Прогнать файл целиком**

Run: `npx vitest run tests/unit/agentSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main/agent/AgentSession.ts tests/unit/agentSession.test.ts
git commit -m "fix: MCP status polling restarts on new triggers and survives a failed check"
```

---

### Task 3: Вопрос агента с несколькими вопросами отвечается целиком (хвост Task 2)

Сейчас карточка показывает и отвечает только первый вопрос `AskUserQuestion`; остальные агент не получает.

**Files:**
- Modify: `src/shared/types.ts` (элемент `question`), `src/shared/ribbon.ts` (`onToolUse` для `AskUserQuestion`, `answerQuestion`), `src/main/agent/AgentSession.ts` (`answerQuestion`, удалить `firstQuestion`), `src/main/agentIpc.ts` (`questionAnswer`), `src/preload/index.ts`, `src/renderer/components/QuestionCard.tsx`, `src/renderer/components/ChatPane.tsx`
- Modify: `tests/fixtures/fake-sdk/index.mjs`, `index.d.mts`, `README.md` (шаг `askQuestion` с `questions`)
- Test: `tests/unit/ribbon.test.ts`, `tests/unit/agentSession.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/e2e/permissions.spec.ts`

**Interfaces:**
- Produces:
  - Элемент ленты `question` становится `{ kind: 'question'; toolUseId: string; questions: QuestionView[]; answers: Record<string, string> | null }`, где `QuestionView = { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }`.
  - `RibbonBuilder.answerQuestion(toolUseId: string, answers: Record<string, string>): RibbonChange[]` — **обновляет и сохранённый элемент** (хвост «emits patch but doesn't update stored item»; если параллельный исполнитель это уже сделал — оставить его код).
  - `AgentSession.answerQuestion(toolUseId: string, answers: Record<string, string>): void` → `updatedInput: { ...input, answers }`. Запасной путь без ожидающего вопроса — одно сообщение: строки `«Вопрос» — ответ`, по строке на вопрос; для одного вопроса — только ответ (как сейчас).
  - IPC `questionAnswer(tabId, toolUseId, answers)`: `answers` — объект строка→строка, не больше 4 ключей, значения ≤ 2000 символов; иное отбрасывается.
  - Фейк: `{ kind: 'askQuestion'; questions?: Array<{ question: string; header?: string; options: string[]; multiSelect?: boolean }> }` (старые `question/options` остаются как сокращение для одного вопроса).

- [ ] **Step 1: Падающие тесты**

```ts
// ribbon.test.ts
test('AskUserQuestion с тремя вопросами — одна карточка со всеми тремя', () => {
  // tool_use с questions[3] → item.questions.length === 3, у каждого options с label и description
})
test('answerQuestion меняет и сохранённый элемент', () => {
  b.answerQuestion(id, { 'Какой?': 'Справа' })
  expect(b.items.find((i) => i.kind === 'question')).toMatchObject({ answers: { 'Какой?': 'Справа' } })
})
// agentSession.test.ts
test('ответы на все вопросы уходят в updatedInput.answers', async () => {
  // фейк askQuestion с двумя вопросами; session.answerQuestion(id, {A:'1', B:'2'})
  expect(driver.questionAnswers).toEqual([{ A: '1', B: '2' }])
})
// ipcValidation.test.ts
test('ответы на вопрос — только строки, не больше четырёх', () => { /* sanitizeQuestionAnswers */ })
```

```ts
// permissions.spec.ts
test('вопрос из двух частей: выбрал оба варианта — агент получил оба', async () => {
  // askQuestion {questions:[{question:'Где?',options:['Слева','Справа']},{question:'Цвет?',options:['Синий','Красный']}]}
  // клик «Справа», клик «Красный», клик [data-testid="question-submit"] («Ответить»)
  // в ленте tool_result фейка содержит и «Справа», и «Красный»
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/ribbon.test.ts tests/unit/agentSession.test.ts tests/unit/ipcValidation.test.ts -t "вопрос|answerQuestion|ответы"`
Expected: FAIL — `questions` нет, отвечается только первый.

- [ ] **Step 3: Реализация**

`sanitizeQuestionAnswers(value: unknown): Record<string, string>` — в `src/main/tabs/sanitize.ts`. Карточка: один вопрос без `multiSelect` — клик по варианту отвечает сразу (как сейчас); иначе варианты отмечаются (у `multiSelect` — несколько), кнопка «Ответить» активна, когда отмечено у каждого вопроса. Под подписью варианта — его `description` текстовым токеном `--text-dim`. Стили — только токены.

- [ ] **Step 4: Прогнать юнит и e2e**

Run: `npx vitest run && npm run build:e2e && npx playwright test tests/e2e/permissions.spec.ts`
Expected: PASS (старый тест вопроса с одним вариантом тоже).

- [ ] **Step 5: Коммит**

```bash
git add src/shared src/main src/preload src/renderer/components/QuestionCard.tsx src/renderer/components/ChatPane.tsx tests
git commit -m "fix: a question card with several questions answers all of them"
```

---

### Task 4: Выбор модели, усилия и режима сохраняется (5.4, хвост 2e)

**Files:**
- Modify: `src/main/store/tabsStore.ts` (удалить свою `sanitizeOverrides`, импортировать из `../tabs/sanitize`), `src/main/agentIpc.ts` (`agentModel`, `agentEffort`, `agentPermissionMode`), `src/main/index.ts` (новая зависимость `rememberDefault`, санитайз `settingsSet`), `src/main/tabs/sanitize.ts` (`sanitizeDefaults`)
- Test: `tests/unit/tabsStore.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/unit/tabController.test.ts`, `tests/e2e/panel.spec.ts` (новый тест «переживает перезапуск»)

**Interfaces:**
- Consumes: `sanitizeOverrides` из `src/main/tabs/sanitize.ts` (уже отбрасывает `bypassPermissions`).
- Produces:
  - `AgentIpcDeps.rememberDefault: (patch: LaunchOverrides) => void` — `index.ts` сливает `sanitizeDefaults(patch)` в `settings.defaults` и сохраняет `settings.json`, шлёт `settingsChanged`.
  - `sanitizeDefaults(value: unknown): LaunchOverrides` — как `sanitizeOverrides`, но `permissionMode: 'bypassPermissions'` превращается в `'default'` (спека: «новая вкладка в этом случае получает `default`»).
  - `settingsSet` пропускает `patch.defaults` через `sanitizeDefaults`.
  - Порядок в IPC: `agentModel` → `session.setModel` → `rememberOverride({model})` → `rememberDefault({model})`; `agentEffort` → то же с `effort`; `agentPermissionMode` → фактический режим → `rememberOverride({permissionMode})` (bypass не запишется — `saveTabs` санитайзит) → `rememberDefault({permissionMode})`.

- [ ] **Step 1: Падающие тесты**

```ts
// tabsStore.test.ts
test('bypassPermissions не попадает в tabs.json', () => {
  saveTabs(dir, [{ id: 't', cwd, title: 't', overrides: { permissionMode: 'bypassPermissions', model: 'm' } }])
  expect(loadTabs(dir)[0]!.overrides).toEqual({ model: 'm' })
})
// ipcValidation.test.ts
test('bypass в умолчаниях становится default', () => {
  expect(sanitizeDefaults({ permissionMode: 'bypassPermissions', effort: 'high' }))
    .toEqual({ permissionMode: 'default', effort: 'high' })
})
// tabController.test.ts
test('новая вкладка берёт модель и усилие, выбранные в другой вкладке', async () => { /* через getDefaults после rememberDefault */ })
test('две вкладки на одной папке хранят свою модель независимо', async () => { /* rememberOverride по id */ })
```

```ts
// panel.spec.ts
test('модель и усилие вкладки переживают перезапуск приложения', async () => {
  // профиль сохраняется между двумя launch(); выбрать модель «Sonnet 5» и усилие «low»
  // (через [data-testid="status-model"]/[data-testid="status-effort"] после Task 15;
  //  до неё — через panel-model/panel-effort), закрыть приложение, открыть с тем же профилем
  // → в строке статуса Sonnet 5 и low; driver получил model 'claude-sonnet-5' при старте
})
```

Пока Task 15 не сделана, e2e пользуется нынешними `panel-model`/`panel-effort`; Task 15 переводит его на `status-*`.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/tabsStore.test.ts tests/unit/ipcValidation.test.ts tests/unit/tabController.test.ts`
Expected: FAIL — bypass сохраняется, `sanitizeDefaults` нет, умолчание не меняется.

- [ ] **Step 3: Реализация** — по Interfaces. В `tabsStore.ts` не остаётся своей копии санитайзера.

- [ ] **Step 4: Прогнать**

Run: `npx vitest run && npm run build:e2e && npx playwright test tests/e2e/panel.spec.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/main tests
git commit -m "feat: model, effort and mode stick per tab and become the default for new tabs"
```

---

### Task 5: Настройки — списки вместо текста, Esc, видимое сохранение, без мёртвого поля (5.4, 5.6)

**Files:**
- Modify: `src/renderer/components/SettingsScreen.tsx`, `SettingsScreen.css`, `src/renderer/app/App.tsx` (передать `models` активной вкладки, `onPatch` возвращает Promise), `src/shared/types.ts` (убрать `fontSize`), `src/main/store/settingsStore.ts` (убрать `fontSize` из `DEFAULT_SETTINGS`), `src/renderer/styles/tokens.css` (убрать `--font-size-terminal`)
- Test: `tests/e2e/settings.spec.ts` (новый), `tests/unit/settingsStore.test.ts`

**Interfaces:**
- Consumes: `sanitizeDefaults` (Task 4) на стороне main.
- Produces: `SettingsScreen` props `{ settings; version; models: ModelOption[]; onPatch: (patch) => Promise<AppSettings>; onClose }`. Поля «Модель по умолчанию» (`setting-defaultModel`: «Как у Claude Code» + модели вкладки + текущее значение, если его нет в списке), «Усилие по умолчанию» (`setting-defaultEffort`: «Как у Claude Code» + `EFFORT_LEVELS` с подписями из панели), «Режим по умолчанию» (`setting-defaultPermissionMode`: все режимы, **кроме** `bypassPermissions`) — `<select>`. Индикатор `settings-saved` с текстом «Сохранено» появляется после ответа `onPatch` и гаснет через 2 с.

- [ ] **Step 1: Падающие тесты**

```ts
// settings.spec.ts
test('режим по умолчанию — список без «без проверок»', async () => {
  const options = await win.locator('[data-testid="setting-defaultPermissionMode"] option').allTextContents()
  expect(options).not.toContain('без проверок'); expect(options).toContain('принимать правки')
})
test('модель по умолчанию — список моделей сессии', async () => { /* «Opus 5», «Sonnet 5» из фейка */ })
test('изменение видно как «Сохранено»', async () => {
  // selectOption → [data-testid="settings-saved"] видим с текстом «Сохранено»
})
test('Esc закрывает настройки и сохраняет поле, которое ещё в фокусе', async () => {
  // ввести путь агента, не уводя фокус, нажать Escape → настройки закрыты;
  // снова открыть → путь сохранён
})
test('поля «Размер шрифта терминала» нет', async () => {
  await expect(win.locator('[data-testid="setting-fontSize"]')).toHaveCount(0)
})
// settingsStore.test.ts
test('старый settings.json с fontSize читается без ошибок', () => { /* лишний ключ не мешает */ })
```

- [ ] **Step 2: Прогнать — падает**

Run: `npm run build:e2e && npx playwright test tests/e2e/settings.spec.ts`
Expected: FAIL — поля текстовые, Esc не закрывает, индикатора нет.

- [ ] **Step 3: Реализация**

Esc ловится на `.settings` (`onKeyDown`): сначала `document.activeElement.blur()` (срабатывает `onBlur`-сохранение), затем `onClose`. Подпись режима — из той же таблицы, что в панели (вынести `MODE_LABEL`, `EFFORT_LABEL` в `src/renderer/labels.ts` и импортировать в `SidePanel`/`StatusLine`).

- [ ] **Step 4: Прогнать**

Run: `npx vitest run tests/unit/settingsStore.test.ts && npx playwright test tests/e2e/settings.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: settings use real dropdowns, close on Esc and show when they are saved"
```

---

### Task 6: Команды — список над полем ввода, без модалки (5.1)

**Files:**
- Create: `src/renderer/components/InlineMenu.tsx`, `InlineMenu.css` (вместо `MentionPopup.*`), `src/renderer/input/slash.ts`, `src/renderer/components/SlashMenu.tsx`
- Delete: `src/renderer/components/CommandPalette.tsx`, `CommandPalette.css`, `MentionPopup.tsx`, `MentionPopup.css`
- Modify: `src/renderer/input/keyPrecedence.ts` (убрать `openPalette`, добавить `popupComplete`), `src/renderer/components/Composer.tsx`, `src/renderer/components/ChatPane.tsx`, `src/renderer/app/App.tsx` (убрать палитру и её состояние), `src/shared/commandFilter.ts` (`withLocalCommands`)
- Test: `tests/unit/slash.test.ts`, `tests/unit/keyPrecedence.test.ts`, `tests/unit/commandFilter.test.ts`, `tests/e2e/commands.spec.ts` (переписать), `tests/e2e/history.spec.ts:170-185` (открыть `/resume` через новый список)

**Interfaces:**
- Produces:
  - `InlineMenuItem { id: string; primary: string; secondary?: string; hint?: string; disabledReason?: string }`; `InlineMenu({ items, selected, onPick, testId, itemTestId, title? })` — список над полем, `role="listbox"`, `aria-activedescendant`, выбранный прокручивается в вид.
  - `findSlashQuery(text: string, caret: number): { query: string } | null` — только если `text` начинается с `/`, до каретки нет пробела и перевода строки.
  - `withLocalCommands(commands: CommandInfo[]): CommandInfo[]` — добавляет `resume`, `model`, `effort`, если сессия их не прислала (с описаниями из `LOCAL_COMMANDS`), и прогоняет `markUnavailable`.
  - `SlashStep = { kind: 'commands' } | { kind: 'model' } | { kind: 'effort' }`. Второй шаг для `/model` — `panel.models` (`primary: displayName`, `secondary: description`), для `/effort` — уровни выбранной модели; Enter применяет через `setModel`/`setEffort` и чистит поле.
  - `ComposerKeyAction` += `'popupComplete'` (Tab при открытом списке), `'openPalette'` удалён. Enter при открытом списке — `'popupAccept'`.
  - Поведение Enter на команде: локальная → своё действие (`resume` — история; `model`/`effort` — второй шаг); с `argumentHint` → в поле `/<name> `, список закрыт, ждёт аргумент; иначе — отправить `/<name>`. Tab — дописать `/<name> ` без отправки. Esc — закрыть список, текст остаётся.
  - testids: список команд `slash-menu`, строка `slash-item`; список файлов прежний `mention-popup`/`mention-item`.

- [ ] **Step 1: Падающие тесты**

```ts
// slash.test.ts
test('слеш в начале — запрос команды', () => expect(findSlashQuery('/com', 4)).toEqual({ query: 'com' }))
test('после пробела — уже аргумент, не запрос', () => expect(findSlashQuery('/model op', 9)).toBeNull())
test('слеш в середине — не команда', () => expect(findSlashQuery('a/b', 3)).toBeNull())
// commandFilter.test.ts
test('локальные команды есть, даже если сессия их не прислала', () => {
  expect(withLocalCommands([]).map((c) => c.name)).toEqual(expect.arrayContaining(['resume', 'model', 'effort']))
})
// keyPrecedence.test.ts: '/' на пустом поле → 'insert'; Tab при popupOpen → 'popupComplete'
```

```ts
// commands.spec.ts (переписан)
test('/ показывает список прямо над полем, модалки нет', async () => {
  await input.press('/')
  await expect(win.locator('[data-testid="slash-menu"]')).toBeVisible()
  await expect(win.locator('[data-testid="command-palette"]')).toHaveCount(0)
  // список выше поля: bottom списка <= top поля
  // строки: имя, описание; у /model видна подсказка аргумента '<model>'
})
test('набор фильтрует, Enter выполняет', async () => { /* '/cmp' + Enter → в ленте '/compact' */ })
test('Tab дописывает команду, не отправляя', async () => { /* '/comp' + Tab → поле '/compact ', ленты нет */ })
test('Esc закрывает список, текст остаётся', async () => {})
test('/model — второй шаг со списком моделей', async () => {
  // '/model' Enter → [data-testid="slash-item"] содержит «Sonnet 5»; ↓ Enter → модель сменилась
})
test('/remote-control помечена и не выполняется', async () => {})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/slash.test.ts tests/unit/keyPrecedence.test.ts tests/unit/commandFilter.test.ts && npm run build:e2e && npx playwright test tests/e2e/commands.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

Команды запрашиваются (`window.qclod.commands(tabId)`) при первом открытии списка во вкладке и обновляются по `onCommandsChanged`; хранятся в сторе `commandsByTab` (добавить в `PER_TAB_KEYS`). Недавние команды (`recentCommands`, до 6) — тоже в сторе. Фильтр — `filterCommands`. Строка списка: `/имя` моноширинно, `argumentHint` моноширинно `--text-faint`, описание `--font-ui`. Список — над полем, ширина поля, максимум 8 видимых строк.

- [ ] **Step 4: Прогнать** юнит, `commands.spec.ts`, `history.spec.ts`, `composer.spec.ts` (упоминания `@` не сломались).

Run: `npx vitest run && npx playwright test tests/e2e/commands.spec.ts tests/e2e/history.spec.ts tests/e2e/composer.spec.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add -A src/renderer src/shared tests
git commit -m "feat: slash commands as an inline list above the input, the modal palette is gone"
```

---

### Task 7: Горячие клавиши вкладок и палитра действий Ctrl+K (5.1, 5.6)

**Files:**
- Create: `src/renderer/app/shortcuts.ts`, `src/renderer/components/ActionPalette.tsx`, `ActionPalette.css`
- Modify: `src/renderer/app/App.tsx` (заменить ручной `onKey` на `resolveAppShortcut`)
- Test: `tests/unit/shortcuts.test.ts`, `tests/e2e/keyboard.spec.ts` (новый)

**Interfaces:**
- Produces:
  - `type AppActionId = 'newTab' | 'closeTab' | 'nextTab' | 'prevTab' | 'tabAt' | 'actions' | 'settings' | 'history' | 'togglePanel' | 'toggleSplit' | 'restart' | 'compact' | 'cycleMode'`
  - `resolveAppShortcut(ev: KeyLike): { id: AppActionId; index?: number } | null` — по физической клавише (`physicalKey`): Ctrl+T, Ctrl+W, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9 (`index` 0…8; Ctrl+9 — последняя вкладка), Ctrl+K, Ctrl+Comma, Ctrl+H, Ctrl+Backslash, Ctrl+Shift+Enter.
  - `APP_ACTIONS: Array<{ id: AppActionId; label: string; keys?: string }>` — подписи: «Новая вкладка» Ctrl+T, «Закрыть вкладку» Ctrl+W, «Следующая вкладка» Ctrl+Tab, «Предыдущая вкладка» Ctrl+Shift+Tab, «Палитра действий» Ctrl+K, «Настройки» Ctrl+,, «Прошлые разговоры» Ctrl+H, «Показать или скрыть панель» Ctrl+\, «Два разговора рядом» Ctrl+Shift+Enter, «Перезапустить сессию», «Сжать контекст», «Сменить режим» Shift+Tab.
  - `hint(label: string, id?: AppActionId): string` → `«Новая вкладка (Ctrl+T)»` — для `title` кнопок (Task 18).
  - `ActionPalette({ onRun, onClose })` — компактное окно сверху по центру, поле + список, fuzzy по подписи (`score` из `commandFilter`), Enter — выполнить, Esc — закрыть. testids `action-palette`, `action-query`, `action-item`.
  - Ctrl+W на вкладке со статусом `busy`/`waiting`: первое нажатие — уведомление над полем `close-guard` «Агент работает — Ctrl+W ещё раз закроет вкладку», второе в течение 3000 мс — закрыть.
  - Ctrl+T — выбор папки, как кнопка «+» (спека v2).

- [ ] **Step 1: Падающие тесты**

```ts
// shortcuts.test.ts
test('Ctrl+T на русской раскладке (е) — новая вкладка', () =>
  expect(resolveAppShortcut(key({ key: 'е', code: 'KeyT', ctrlKey: true }))).toEqual({ id: 'newTab' }))
test('Ctrl+3 — третья вкладка', () =>
  expect(resolveAppShortcut(key({ key: '3', code: 'Digit3', ctrlKey: true }))).toEqual({ id: 'tabAt', index: 2 }))
test('Ctrl+Shift+Tab — предыдущая', () => {})
test('Ctrl+K — палитра действий', () => {})
test('буква без Ctrl — ничего', () => expect(resolveAppShortcut(key({ key: 't', code: 'KeyT' }))).toBeNull())
```

```ts
// keyboard.spec.ts — QCLOD_PICK_FOLDER указывает на временную папку
test('Ctrl+T открывает вкладку, Ctrl+1/Ctrl+2 переключают, Ctrl+Tab по кругу', async () => {})
test('Ctrl+W закрывает свободную вкладку сразу', async () => {})
test('Ctrl+W на работающей вкладке закрывает только со второго раза', async () => {
  // nextTurn с textStream pauseMs 400 → отправить, Ctrl+W → видно close-guard, вкладок столько же;
  // Ctrl+W ещё раз → вкладка закрыта
})
test('Ctrl+K открывает палитру действий; «настр» + Enter открывает настройки', async () => {})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/shortcuts.test.ts && npm run build:e2e && npx playwright test tests/e2e/keyboard.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация** — обработчик `keydown` на `window` в `App` вызывает `resolveAppShortcut` и одну функцию `runAction(id, index?)`, которую зовёт и палитра. Старые `Ctrl+H/\/Shift+Enter` проходят через неё же.

- [ ] **Step 4: Прогнать** `shortcuts.test.ts`, `keyboard.spec.ts`, `panel.spec.ts` (хоткей панели), `history.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests
git commit -m "feat: tab hotkeys and a Ctrl+K palette of app actions"
```

---

### Task 8: Карточка инструмента знает всё о вызове (данные для 5.3)

Сейчас карточка хранит только `target`, `summary` и текст результата — раскрывать нечего. Здесь лента начинает хранить вход, структурный выход и время; вид — в Task 9.

**Files:**
- Create: `src/shared/clip.ts`, `src/shared/format.ts`, `src/shared/toolView.ts`
- Modify: `src/shared/types.ts` (поля `tool`/`toolError`), `src/shared/ribbon.ts` (`onToolUse`, `onToolResult`, `lines`/`clip` → `format.ts`), `tests/fixtures/fake-sdk/index.mjs`, `index.d.mts`, `README.md` (у `tool`: `output`, `pauseMs`; у `toolError`: `output`)
- Test: `tests/unit/clip.test.ts`, `tests/unit/format.test.ts`, `tests/unit/toolView.test.ts`, `tests/unit/ribbon.test.ts`, `tests/unit/fakeSdk.test.ts`

**Interfaces:**
- Produces:
  - Поля у `tool` и `toolError`: `input?: Record<string, unknown>`, `output?: unknown`, `startedAt?: number`, `durationMs?: number`. Необязательные — старые снимки и записи читаются.
  - `VIEW_CLIP = 20_000`; `clipForView(value: unknown, maxChars = VIEW_CLIP): unknown` — строки длиннее `maxChars` обрезаются с пометкой `…[обрезано: N символов]`, массивы — до 500 элементов, глубина — до 6; ключи `originalFile` и `file.base64` выбрасываются.
  - `format.ts`: `plural(n, one, few, many)`, `lines(n)`, `seconds(ms)` → `«1,2 с»`, `«42 с»`, `«3 мин 20 с»`; `compactNumber(n)` → `15k`; `bytes(n)` → `«12 КБ»`, `«1,4 МБ»`. Дубли в `RibbonItem.tsx`, `Working.tsx`, `SidePanel.tsx` заменяются импортом по мере того, как задачи их трогают.
  - `type ToolCardItem = Extract<RibbonItem, { kind: 'tool' | 'toolError' }>`
  - `toolView(item: ToolCardItem): ToolView`, где
    ```ts
    type ToolView =
      | { type: 'command'; command: string; description: string; stdout: string; stderr: string;
          interrupted: boolean; backgroundTaskId?: string; note?: string }
      | { type: 'edit'; path: string; hunks: DiffHunk[]; added: number; removed: number }
      | { type: 'write'; path: string; created: boolean; size: number; head: string[]; totalLines: number;
          hunks: DiffHunk[]; added: number; removed: number }
      | { type: 'read'; path: string; startLine: number; numLines: number; totalLines: number; preview: string[] }
      | { type: 'search'; pattern: string; where: string; files: string[]; content: string; count: number;
          unit: 'files' | 'matches' | 'lines' }
      | { type: 'web'; url?: string; query?: string; status?: string; results: Array<{ title: string; url: string }>; text: string }
      | { type: 'mcp'; server: string; tool: string; args: Array<{ key: string; value: string }>; result: string }
      | { type: 'generic'; text: string }
    interface DiffHunk { oldStart: number; newStart: number; lines: string[] }  // lines с префиксом ' ', '+', '-'
    ```
    Без `output` (старая запись) — из `input` и текста результата: Edit — `old_string`/`new_string` как один кусок «−/+», Write — `content`, остальное — `generic`.
  - `toolOutcome(item: ToolCardItem, view: ToolView): string` — правая часть свёрнутой строки: правка `«+12 −3»`; запись новая `«новый · 40 строк»`, иначе `«+a −r»`; чтение `«строки 10–129 из 300»` или `«120 строк»`; поиск `«42 совпадения»` / `«17 файлов»`; команда `«готово · 1,2 с»`, `«ошибка · 1,2 с»`, `«прервано»`, `«в фоне»`; web `«200 · 12 КБ»` / `«8 результатов»`; MCP/прочее — `«готово»`. Время — только если `durationMs ≥ 100`.
  - `RibbonBuilder`: на `tool_use` кладёт `input: clipForView(input)` и `startedAt: now()`; на результате — `output: clipForView(tool_use_result)`, `durationMs = now() - startedAt` (если > 0). Ошибочная карточка сохраняет `input`, `startedAt`, `durationMs`.
  - Фейк: `{ kind: 'tool'; …; output?: object; pauseMs?: number }` — `output` уходит как `tool_use_result` рядом с `tool_result`; `pauseMs` — пауза между `tool_use` и результатом.

- [ ] **Step 1: Падающие тесты**

```ts
// toolView.test.ts
test('Bash: stdout и stderr раздельно, описание из входа', () => {
  const v = toolView(tool('Bash', { command: 'npm test', description: 'Run tests' },
    { stdout: 'ok', stderr: 'warn', interrupted: false }))
  expect(v).toMatchObject({ type: 'command', command: 'npm test', stdout: 'ok', stderr: 'warn' })
})
test('Edit: дифф из structuredPatch и счёт строк', () => {
  const v = toolView(tool('Edit', { file_path: 'C:\\p\\a.ts' }, { filePath: 'C:\\p\\a.ts',
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }] }))
  expect(v).toMatchObject({ type: 'edit', added: 2, removed: 1 })
  expect(toolOutcome(item, v)).toBe('+2 −1')
})
test('Edit без output — из old_string/new_string', () => {})
test('Read: диапазон строк и превью', () => { /* 'строки 10–129 из 300' */ })
test('Grep: совпадения и файлы', () => { /* numMatches 42 → '42 совпадения' */ })
test('WebSearch: заголовки результатов', () => {})
test('MCP: сервер, инструмент, аргументы таблицей', () => {
  expect(toolView(tool('mcp__gh__create_issue', { title: 'Баг', labels: ['a'] }, undefined)))
    .toMatchObject({ type: 'mcp', server: 'gh', tool: 'create_issue',
      args: [{ key: 'title', value: 'Баг' }, { key: 'labels', value: '["a"]' }] })
})
test('команда с ошибкой: «ошибка · 1,2 с»', () => {})
test('время короче 100 мс не печатается', () => {})
// clip.test.ts
test('мегабайт stdout режется до VIEW_CLIP с пометкой', () => {
  const out = clipForView({ stdout: 'x'.repeat(1_000_000) }) as { stdout: string }
  expect(out.stdout.length).toBeLessThan(VIEW_CLIP + 60); expect(out.stdout).toContain('обрезано')
})
test('originalFile и base64 картинки выбрасываются', () => {})
// ribbon.test.ts
test('карточка хранит вход, выход и время вызова', () => {
  // clock: now 1000 на tool_use, 2200 на результате
  expect(item).toMatchObject({ input: { command: 'ls' }, output: { stdout: 'a' }, durationMs: 1200 })
})
test('ошибка сохраняет вход и время', () => {})
// fakeSdk.test.ts
test('шаг tool с output отдаёт tool_use_result', async () => {})
test('шаг tool с pauseMs держит паузу до результата', async () => {})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/clip.test.ts tests/unit/format.test.ts tests/unit/toolView.test.ts tests/unit/ribbon.test.ts tests/unit/fakeSdk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Тест Review Focus 5 (`clip.test.ts`, мегабайт) обязателен.

- [ ] **Step 4: Прогнать всё юнит и типы**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/shared tests
git commit -m "feat: tool cards keep the call's input, structured output and duration"
```

---

### Task 9: Карточки инструментов — категория, одна строка свёрнуто, подробности раскрыто (5.3)

**Files:**
- Create: `src/renderer/components/tool/ToolBody.tsx` (тело по `ToolView.type`), `src/renderer/components/tool/DiffView.tsx`, `src/renderer/components/tool/RawJson.tsx`, `src/renderer/components/tool/Tool.css`
- Modify: `src/renderer/components/ToolCard.tsx` (переписать), `src/renderer/components/RibbonItem.tsx` (мысли), `src/renderer/components/Ribbon.css` (убрать стили старой карточки и `.row-thinking`)
- Test: `tests/e2e/chat.spec.ts` (новый), `tests/e2e/ribbon.spec.ts:52-115` (обновить селекторы)

**Interfaces:**
- Consumes: `toolCategory`, `CategoryIcon` (Task 1), `toolView`, `toolOutcome`, `seconds`, `bytes` (Task 8).
- Produces:
  - `ToolCard({ item, cwd, tabId, compact? }: { item: ToolCardItem; cwd: string; tabId: string; compact?: boolean })`. `ChatPane` передаёт `cwd` вкладки до `Ribbon` и `RibbonRow`.
  - Свёрнутая строка (`tool-head`): полоска `--rule-category` цвета категории слева, значок, название по-человечески (`TOOL_TITLE`: Read «Чтение», Edit «Правка», Write «Запись», Bash «Команда», Grep «Поиск», Glob «Поиск файлов», WebFetch «Страница», WebSearch «Поиск в сети», MCP — `server · tool`, прочее — имя), главный аргумент (путь — `PathLink` после Task 11, до неё — текст; команда — моноширинно), итог `toolOutcome` справа, статус: идёт — `LoaderCircle` с вращением (уважает `prefers-reduced-motion`), ошибка — `CircleAlert`.
  - Раскрытая — `ToolBody` по типу: команда — команда целиком, папка (`cwd`), блоки `tool-stdout` и `tool-stderr` (у каждого прокрутка до 320px и кнопка «Показать всё», снимающая предел высоты), время; правка — путь, `DiffView` (строки `+` на `--cat-edit`-полутоне через `color-mix`, `−` на `--status-critical`-полутоне, номера строк), число строк; запись — путь, размер, первые 20 строк; чтение — путь, диапазон, превью; поиск — запрос, где, список файлов (`tool-match`); web — URL/запрос, заголовки; MCP — сервер, инструмент, таблица `tool-args` ключ–значение, результат. Внизу у любого — свёрнутый `RawJson` «Вход и выход как есть» (`tool-raw`).
  - Ошибка — категория та же, значок ошибки, **раскрыта сразу**, текст ошибки сверху тела.
  - Мысли: строка `thinking-head` «Думал 12 с» (`Brain`), пока идут — «Думает…»; раскрытие показывает текст.

- [ ] **Step 1: Падающие тесты**

```ts
// chat.spec.ts
test('у карточек разных категорий свои значок и цвет', async () => {
  // steps: Read, Grep, Edit (output structuredPatch), Bash (output stdout/stderr), mcp__gh__x
  // каждая tool-card имеет data-category = read/search/edit/command/mcp и svg внутри tool-head;
  // computed border-left-color карточки Edit != карточки Bash
})
test('свёрнутая правка показывает +N −M', async () => { /* tool-head содержит «+2 −1» */ })
test('раскрытая команда: команда, stdout и stderr раздельно', async () => {
  // клик по tool-head Bash → видны tool-stdout «ok» и tool-stderr «warn», текст «npm test»
})
test('раскрытая правка показывает дифф построчно', async () => { /* .diff-line.is-add ×2, .is-del ×1 */ })
test('MCP раскрывается таблицей аргументов', async () => { /* tool-args содержит title / Баг */ })
test('внизу любой карточки — сырые вход и выход', async () => { /* tool-raw */ })
test('мысли свёрнуты строкой «Думал N с»', async () => {})
```

В `ribbon.spec.ts` тест «ошибка раскрыта сразу» остаётся и должен пройти без правки сути.

- [ ] **Step 2: Прогнать — падает**

Run: `npm run build:e2e && npx playwright test tests/e2e/chat.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация.** Карточка — `<details>`; ошибка — `open` по умолчанию. `data-category` на корне карточки — и для тестов, и для CSS (`.tool-card[data-category="edit"] { --cat: var(--cat-edit) }`). Никаких hex в CSS.

- [ ] **Step 4: Прогнать** `chat.spec.ts`, `ribbon.spec.ts`, `formatting.spec.ts`, `planmode.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests/e2e
git commit -m "feat: tool cards show their category and open into structured details"
```

---

### Task 10: Распознавание путей и безопасные действия с ними (5.2, main)

**Files:**
- Create: `src/shared/pathCandidates.ts`, `src/main/files/pathResolver.ts`, `src/main/files/fileActions.ts`
- Modify: `src/shared/channels.ts`, `src/shared/types.ts` (`ResolvedPath`), `src/main/agentIpc.ts` (новые обработчики), `src/preload/index.ts`, `src/main/index.ts` (один `PathResolver` на приложение; сеам записи действий)
- Test: `tests/unit/pathCandidates.test.ts`, `tests/unit/pathResolver.test.ts`, `tests/unit/fileActions.test.ts`, `tests/unit/channels.test.ts`

**Interfaces:**
- Produces:
  - `PathCandidate { text: string; start: number; end: number; path: string; line?: number; column?: number }`; `findPathCandidates(text: string): PathCandidate[]`.
  - `ResolvedPath { raw: string; absPath: string; isDir: boolean; line?: number; column?: number }`.
  - `class PathResolver { constructor(opts?: { ttlMs?: number; maxEntries?: number; stat?: (p: string) => Promise<{ isDirectory(): boolean }> }); resolve(cwd: string, raws: string[]): Promise<Array<ResolvedPath | null>>; knows(absPath: string): boolean }` — кэш `Map<absPath, { exists, isDir, at }>`, TTL 30 000 мс, не больше 5000 записей (старейшие уходят), не больше 200 кандидатов за вызов.
  - `fileActions.ts`: `isRunnable(path: string): boolean` (расширения `.exe .bat .cmd .com .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .msi .msp .scr .hta .lnk .jar .reg .cpl .pif .appref-ms`); `openPath(abs: string): Promise<'opened' | 'revealed'>` — исполняемое не открывается, а показывается в проводнике; `revealPath(abs)`; `buildEditorCommand(template: string, target: { path: string; line?: number; column?: number }): string` — подставляет `{path}`, `{line}`, `{column}` (нет строки — `1`), каждое значение через `quoteArg` из `src/main/setup/install.ts`; `openInEditor(template, target)` — `spawn('cmd.exe', ['/d','/s','/c', line], { detached: true, windowsHide: true, windowsVerbatimArguments: true })`.
  - Каналы: `filesResolve 'files:resolve'` (`tabId, raws[]` → `Array<ResolvedPath|null>`, относительно `cwd` вкладки), `filesOpen 'files:open'`, `filesReveal 'files:reveal'`, `filesOpenInEditor 'files:openInEditor'` (`tabId, absPath, line?, column?`). Действия принимают **только** `absPath`, который `resolver.knows()` как существующий, или путь внутри `userData/pastes` (Task 19); иначе молча ничего.
  - Сеам e2e: при `__QCLOD_TEST_SEAMS__ && process.env.QCLOD_FAKE_SHELL` действия не вызывают `shell`/`spawn`, а пишут `{ action, path, line? }` в `globalThis.__qclodShellLog` (массив).
  - Preload: `resolvePaths(tabId, raws)`, `openPath(tabId, absPath)`, `revealPath(tabId, absPath)`, `openInEditor(tabId, absPath, line?, column?)`.

**Алгоритм кандидатов** (сигнатура его не определяет):
1. Абсолютные Windows: `/[A-Za-z]:[\\/][^\s"'<>|*?\`]*/g`.
2. Прочие токены: текст режется по пробелам и `()[]{}<>,;"'«»\``; токен — кандидат, если содержит `/` или `\`, либо это имя с расширением `[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}`.
3. Отбрасываются: содержит `://`; начинается с `//` или `\\` (UNC, `\\?\`); состоит только из цифр, точек и слешей (`1/2`, `10.11.2026`, `v1.2`); пустые сегменты (`a//b`).
4. С конца снимаются `.,:;!?)` и затем суффикс `:(\d+)(?::(\d+))?$` → `line`, `column`.
5. Внутри инлайн-кода (`` `C:\Мои проекты\a b.ts` ``) кандидат — весь спан, если пункт 1 или 2 его принимает; так пути с пробелами распознаются, когда агент взял их в кавычки-код.

- [ ] **Step 1: Падающие тесты**

```ts
// pathCandidates.test.ts
test('абсолютный путь с обратными и прямыми слешами', () => {
  expect(findPathCandidates('см. C:\\proj\\src\\a.ts и C:/x/y.md').map((c) => c.path))
    .toEqual(['C:\\proj\\src\\a.ts', 'C:/x/y.md'])
})
test('строка и колонка на конце', () => {
  expect(findPathCandidates('src/main/index.ts:42:7,')[0]).toMatchObject({ path: 'src/main/index.ts', line: 42, column: 7 })
})
test('путь с пробелом и кириллицей в инлайн-коде', () => {
  expect(findPathCandidates('файл `C:\\Мои проекты\\план 1.md`')[0]!.path).toBe('C:\\Мои проекты\\план 1.md')
})
test('не пути: URL, дробь, дата, версия', () => {
  expect(findPathCandidates('https://a.b/c 1/2 10.11.2026 v1.2')).toEqual([])
})
test('UNC и \\\\?\\ не кандидаты', () => {
  expect(findPathCandidates('\\\\server\\share\\x.txt \\\\?\\C:\\x.txt')).toEqual([])
})
// pathResolver.test.ts (stat — vi.fn)
test('несуществующее — null, существующее — абсолютный путь от cwd', async () => {})
test('повторный запрос в пределах TTL не трогает диск', async () => { expect(stat).toHaveBeenCalledTimes(1) })
test('больше 200 кандидатов — лишние null без stat', async () => {})
// fileActions.test.ts
test.each(['setup.exe', 'deploy.BAT', 'x.ps1', 'link.lnk'])('%s — исполняемое', (n) => expect(isRunnable(`C:\\p\\${n}`)).toBe(true))
test('openPath для .exe показывает в проводнике, не запускает', async () => {
  // shell подменён vi.mock('electron'): openPath не вызван, showItemInFolder вызван, ответ 'revealed'
})
test('команда редактора: путь с пробелом и & в кавычках', () => {
  expect(buildEditorCommand('code -g {path}:{line}', { path: 'C:\\a b&c\\x.ts', line: 3 }))
    .toBe('code -g "C:\\a b&c\\x.ts:3"')
})
```

Тесты Review Focus 1 (`.exe`) и 2 (UNC) обязательны.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/pathCandidates.test.ts tests/unit/pathResolver.test.ts tests/unit/fileActions.test.ts`
Expected: FAIL — модулей нет.

- [ ] **Step 3: Реализация** — по Interfaces. `buildEditorCommand` подставляет `{path}:{line}` как **один** аргумент, если они стоят в шаблоне слитно (как в примере); `quoteArg` применяется к итоговому аргументу.

- [ ] **Step 4: Прогнать**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/shared src/main src/preload tests/unit
git commit -m "feat: recognise file paths that exist and open them safely"
```

---

### Task 11: Кликабельные пути и меню по правому клику (5.2, окно)

**Files:**
- Create: `src/renderer/paths/linkify.ts`, `src/renderer/paths/useResolvedPaths.ts`, `src/renderer/paths/PathLink.tsx`, `src/renderer/paths/PathMenu.tsx`, `src/renderer/paths/Paths.css`
- Modify: `src/renderer/markdown/Markdown.tsx` (prop `tabId`, пути в тексте и инлайн-коде), `src/renderer/components/RibbonItem.tsx`, `src/renderer/components/tool/ToolBody.tsx`, `ToolCard.tsx` (главный аргумент), `src/renderer/state/useAppStore.ts` (`pathsByTab` в `PER_TAB_KEYS`), `src/shared/types.ts` (`AppSettings.editorCommand: string`), `src/main/store/settingsStore.ts` (по умолчанию `''`), `SettingsScreen.tsx` (поле «Команда редактора», `setting-editorCommand`, подсказка `code -g {path}:{line}`)
- Test: `tests/unit/linkify.test.ts`, `tests/e2e/paths.spec.ts` (новый, `QCLOD_FAKE_SHELL=1`)

**Interfaces:**
- Consumes: каналы и `findPathCandidates` из Task 10.
- Produces:
  - `linkify(text: string, resolved: ReadonlyMap<string, ResolvedPath>): Array<string | { text: string; target: ResolvedPath }>`.
  - `useResolvedPaths(tabId: string, raws: string[]): ReadonlyMap<string, ResolvedPath>` — спрашивает main пачкой (дебаунс 50 мс), помнит ответы в `pathsByTab` (в том числе `null`, чтобы не спрашивать снова); текст, который ещё стримится, не спрашивает (только `streaming: false`).
  - `PathLink({ tabId, target, children })` — `<a>` с `data-testid="path-link"`, вид — как текст, подчёркивание только при наведении и фокусе (`:focus-visible`); клик → `openPath` (папка открывается в проводнике тем же вызовом); правый клик или Shift+F10 → `PathMenu`.
  - Где линкуются пути: текст агента (`Markdown`, вне блоков кода), главный аргумент карточки, `stdout`/`stderr` команды и список совпадений поиска в `ToolBody`, объект живой строки.
  - `PathMenu` — меню у курсора, `role="menu"`, стрелки, Enter, Esc. Пункты: «Открыть», «Показать в проводнике», «Скопировать путь», «Скопировать относительный путь» (от `cwd` вкладки), «Открыть в редакторе» — только если `settings.editorCommand` не пуст, со строкой. testids `path-menu`, `path-menu-item`. Копирование — `navigator.clipboard.writeText`.

- [ ] **Step 1: Падающие тесты**

```ts
// linkify.test.ts
test('известный путь становится ссылкой, остальное — текстом', () => {
  expect(linkify('правил src/a.ts:3 и b', new Map([['src/a.ts:3', target]])))
    .toEqual(['правил ', { text: 'src/a.ts:3', target }, ' и b'])
})
```

```ts
// paths.spec.ts — во временной папке вкладки лежат src/a.ts и setup.exe (пустой файл)
test('путь в ответе агента кликабелен и открывается', async () => {
  // text: 'Посмотрите src/a.ts:3 и src/нет.ts' → path-link ровно один, «src/a.ts:3»
  // клик → globalThis.__qclodShellLog содержит { action: 'open', path: <abs a.ts> }
})
test('правый клик — меню; «Скопировать относительный путь» кладёт src\\a.ts в буфер', async () => {
  // app.evaluate(({ clipboard }) => clipboard.readText()) === 'src\\a.ts'
})
test('«Показать в проводнике»', async () => {})
test('«Открыть в редакторе» есть только с заданной командой и передаёт строку', async () => {
  // без настройки пункта нет; задать editorCommand → пункт есть → лог { action: 'editor', line: 3 }
})
test('путь к .exe не запускается, а показывается в проводнике', async () => {
  // клик по setup.exe → лог { action: 'reveal' }, а не 'open'
})
test('путь в карточке Read кликабелен', async () => {})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/linkify.test.ts && npm run build:e2e && npx playwright test tests/e2e/paths.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Кодовые блоки (```) не линкуются — это код, не упоминание.

- [ ] **Step 4: Прогнать** `paths.spec.ts`, `formatting.spec.ts`, `chat.spec.ts`, `settings.spec.ts`, юнит.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: clickable file paths with a context menu and an optional editor command"
```

---

### Task 12: Подагент — карточка со своей лентой шагов и отчётом (5.3)

**Files:**
- Create: `src/renderer/components/SubagentCard.tsx`, `src/renderer/chat/children.ts`
- Modify: `src/shared/types.ts` (`subagent.report?: string`), `src/shared/ribbon.ts` (полный отчёт), `src/renderer/components/RibbonItem.tsx` (ветка `subagent` → `SubagentCard`), `src/renderer/components/Ribbon.tsx` (дети — один раз на рендер; padTop/padBottom из `offsets`)
- Test: `tests/unit/ribbon.test.ts`, `tests/unit/children.test.ts`, `tests/e2e/chat.spec.ts`, `tests/e2e/ribbon.spec.ts` (5000 элементов — регрессия)

**Interfaces:**
- Produces:
  - `report?: string` у `subagent` — текст `AgentOutput.content[].text` (или `tool_result`, если структуры нет), обрезка `clipForView` до 8000 символов **с переводами строк**; у фонового — `summary` уведомления.
  - `childrenByParent(items: RibbonItem[]): ReadonlyMap<string, RibbonItem[]>` — один проход; `Ribbon` строит его раз за рендер и передаёт детям (снимает O(n·k) из `progress.md` v2).
  - `SubagentCard({ item, steps, tabId, cwd })`: шапка — `Bot` цвета `--cat-agent`, тип (`name`), задача, статус (идёт / готово / ошибка / остановлен / не закончил), время, «N шагов»; раскрытие на месте показывает **ленту шагов** — те же `ToolCard` с `compact`, текст подагента, вложенный подагент — рекурсивно `SubagentCard`; внизу — отчёт (`subagent-report`) Markdown-ом. Работающий подагент показывает последний инструмент в шапке. testids: `subagent-head`, `subagent-steps`, `subagent-step-count`, `subagent-report`.
  - Подсчёт `padBottom`: `total - (offsets[last] ?? total)` — по смещениям, без повторного поиска высоты.

- [ ] **Step 1: Падающие тесты**

```ts
// ribbon.test.ts
test('отчёт подагента — весь текст из AgentOutput.content, с переводами строк', () => {
  expect(item.report).toBe('Нашёл три места:\n1. a.ts\n2. b.ts\n3. c.ts')
})
// children.test.ts
test('дети собраны по родителю за один проход, порядок сохранён', () => {})
```

```ts
// chat.spec.ts
test('подагент раскрывается в свою ленту шагов и отчёт внизу', async () => {
  // subagent со steps [Read, Grep, text] и stats → subagent-step-count «2 шага»;
  // клик subagent-head → subagent-steps содержит две tool-card с data-category read/search;
  // subagent-report содержит текст отчёта
})
test('вложенный подагент показан внутри родителя', async () => {})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/ribbon.test.ts tests/unit/children.test.ts && npm run build:e2e && npx playwright test tests/e2e/chat.spec.ts -g "подагент"`
Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Фейку для отчёта ничего не нужно: `subagent` уже отдаёт `content` (README, шаг `subagent`); если нет — дописать `content` из последнего `text`-шага.

- [ ] **Step 4: Прогнать** `chat.spec.ts`, `ribbon.spec.ts` (5000 элементов и прокрутка), `panel.spec.ts`, `resumedPanel.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: subagent cards open into their own step ribbon with the full report"
```

---

### Task 13: Живая строка «сейчас» вместо «Working» (5.3)

**Files:**
- Create: `src/renderer/chat/nowActivity.ts`, `src/renderer/components/NowLine.tsx`, `NowLine.css`
- Delete: `src/renderer/components/Working.tsx`, `Working.css`
- Modify: `src/renderer/components/ChatPane.tsx`
- Test: `tests/unit/nowActivity.test.ts`, `tests/e2e/chat.spec.ts`

**Interfaces:**
- Consumes: `toolCategory` (Task 1), `input` карточки (Task 8), `PathLink` (Task 11).
- Produces:
  - `NowActivity { category: ToolCategory | 'thinking' | 'writing' | 'waiting'; verb: string; object: string; objectKind: 'path' | 'code' | 'text' | 'none'; path?: string; runningAgents: Array<{ id: string; name: string; task: string; lastTool?: string }> }`
  - `nowActivity(items: RibbonItem[], status: SessionStatus): NowActivity | null` — `null`, если статус не `busy`/`waiting`. Берётся **самый новый работающий элемент верхнего уровня**: `waiting` → «Ждёт ответа»; инструмент → глагол по имени: Read «Читает», Glob «Ищет файлы», Grep «Ищет», WebSearch «Ищет в сети», WebFetch «Открывает», Edit/MultiEdit/NotebookEdit «Правит», Write «Пишет», Bash/PowerShell «Запускает», Agent «Поручил агенту», `mcp__*` — «MCP» + `server · tool`, TodoWrite «Обновляет план», прочее «Вызывает»; объект: файл — имя файла (`objectKind: 'path'`, `path` — полный), команда — первая строка (`'code'`), Grep — `"pattern"`, WebFetch — хост, Agent — задача; незакрытые мысли — «Думает», стримящийся текст — «Пишет ответ», иначе — «Думает». `runningAgents` — все `subagent` в состоянии `running`, кроме того, что уже назван глаголом.
  - `NowLine({ tabId, status, since, items })`: полоска и значок категории, глагол (`now-what`), объект (`now-object`, путь — `PathLink`), таймер хода `m:ss` (`now-time`), при `runningAgents.length > 0` — кнопка `now-agents` «2 агента», клик раскрывает список вверх (`now-agents-list`: тип, задача, последний инструмент). Подсказка «Esc — прервать» — в `title` строки.

- [ ] **Step 1: Падающие тесты**

```ts
// nowActivity.test.ts
test('Read — «Читает» и имя файла', () => {
  expect(nowActivity([runningTool('Read', { file_path: 'C:\\p\\src\\index.ts' })], 'busy'))
    .toMatchObject({ category: 'read', verb: 'Читает', object: 'index.ts', objectKind: 'path', path: 'C:\\p\\src\\index.ts' })
})
test('Bash — «Запускает» и команда', () => {})
test('Grep — «Ищет» и шаблон в кавычках', () => {})
test('ожидание разрешения — «Ждёт ответа»', () => {})
test('свободная сессия — null', () => expect(nowActivity([], 'idle')).toBeNull())
test('работающие подагенты считаются', () => { /* два running subagent → runningAgents.length 2 */ })
```

```ts
// chat.spec.ts
test('пока идёт команда, строка «сейчас» говорит «Запускает npm test»', async () => {
  // nextTurn: tool Bash {command:'npm test'} pauseMs 1500 → now-what «Запускает», now-object «npm test»
})
test('два фоновых подагента — «2 агента», клик раскрывает список', async () => {
  // два backgroundAgent с progress и pauseMs → now-agents «2 агента» → now-agents-list с двумя строками
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/nowActivity.test.ts && npm run build:e2e && npx playwright test tests/e2e/chat.spec.ts -g "сейчас|агента"`
Expected: FAIL.

- [ ] **Step 3: Реализация.** Строка видна, только пока ход идёт; фоновые подагенты после конца хода показываются той же строкой без таймера хода, с одной кнопкой «2 агента» (статус вкладки `idle`, но `runningAgents` не пуст).

- [ ] **Step 4: Прогнать** `chat.spec.ts`, `ribbon.spec.ts`, `permissions.spec.ts` (ожидание), юнит.

- [ ] **Step 5: Коммит**

```bash
git add -A src/renderer tests
git commit -m "feat: a live line says what the agent is doing right now"
```

---

### Task 14: План задач — полоска прогресса над полем (5.3)

**Files:**
- Create: `src/renderer/components/TodoStrip.tsx`, `TodoStrip.css`
- Delete: `src/renderer/components/TodoPanel.tsx`
- Modify: `src/shared/types.ts` (`TodoItem.activeForm?: string`), `src/shared/ribbon.ts` (читать `activeForm`), `src/renderer/components/Ribbon.tsx` (убрать липкий список, prop `todo`), `ChatPane.tsx`
- Test: `tests/unit/ribbon.test.ts`, `tests/e2e/ribbon.spec.ts:117-143` (переписать)

**Interfaces:**
- Produces: `TodoStrip({ items, status })` — строка `todo-strip`: `ListChecks`, «Задачи 3/7», текст текущей задачи (`activeForm` задачи `in_progress`, иначе её `content`); клик раскрывает список вверх `todo-list` с `todo-item` (`Check` — готово, `LoaderCircle` — идёт, кружок — ждёт). Видна, пока есть невыполненные задачи или идёт ход. Лента больше ничего не закрепляет сверху.

- [ ] **Step 1: Падающие тесты**

```ts
// ribbon.test.ts
test('activeForm задачи доезжает до списка', () => {})
// ribbon.spec.ts
test('план — полоска «Задачи 1/3» над полем, лента не перекрыта', async () => {
  // todo с тремя задачами → todo-strip «Задачи 1/3» и текст in_progress;
  // [data-testid="todo-panel"] нет; верх первой строки ленты не под полоской (boundingBox)
  // клик → todo-list с тремя todo-item
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/ribbon.test.ts -t activeForm && npm run build:e2e && npx playwright test tests/e2e/ribbon.spec.ts -g "план"`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces.

- [ ] **Step 4: Прогнать** `ribbon.spec.ts`, юнит.

- [ ] **Step 5: Коммит**

```bash
git add -A src tests
git commit -m "feat: the todo list is a compact progress strip above the input"
```

---

### Task 15: Строка статуса у поля ввода — переключатели, контекст, лимиты (5.5)

**Files:**
- Create: `src/renderer/components/StatusLine.tsx`, `StatusLine.css`, `src/renderer/components/Dropdown.tsx`, `src/renderer/components/ContextBanner.tsx`, `src/renderer/chat/contextLevel.ts`, `src/renderer/app/panelVisibility.ts`
- Modify: `ChatPane.tsx`, `App.tsx` (видимость панели от ширины окна), `SidePanel.tsx` (убрать селекты модели/усилия/режима, оставить модель строкой), `src/renderer/labels.ts`
- Test: `tests/unit/contextLevel.test.ts`, `tests/unit/panelVisibility.test.ts`, `tests/e2e/statusline.spec.ts` (новый), `tests/e2e/panel.spec.ts` (перевести `panel-model`/`panel-effort`/`panel-mode` на `status-*`), `tests/e2e/planmode.spec.ts` и `resumedPanel.spec.ts` (то же, где встречаются)

**Interfaces:**
- Consumes: `PanelData` (есть), `EFFORT_LABEL`/`MODE_LABEL` (Task 5), `CircleAlert`.
- Produces:
  - `contextLevel(percent: number): 'ok' | 'warn' | 'critical'` — `≥ 90` critical, `≥ 80` warn.
  - `PANEL_MIN_WIDTH = 1100`; `panelVisible({ setting, width, override }: { setting: boolean; width: number; override: 'open' | 'closed' | null }): boolean` — `override` побеждает; без него — `setting && width >= PANEL_MIN_WIDTH`. Кнопка панели при узком окне ставит `override` (на сессию окна, не в настройки); пересечение порога сбрасывает `override`.
  - `Dropdown({ testId, label, value, options, onChange, title })` — кнопка-значение и список вверх (`InlineMenu` из Task 6), клавиатура ↑↓ Enter Esc.
  - `StatusLine({ tabId, data, started })`: слева `status-mode` (Shift+Tab по-прежнему крутит три режима; `bypassPermissions` выбирается здесь и проходит подтверждение), `status-model`, `status-effort` (уровни выбранной модели); справа `status-context` — meter 48×6px + «42%» (`title`: «Контекст: 84 000 из 200 000 токенов»; оценка по записи — «≈42%»), `status-limit-5h` «5 ч 13%», `status-limit-7d` «нед 38%» (meter того же вида, `title` — когда сброс), слот для `status-bg` (Task 22). Уровень `contextLevel` ставит `data-level` на meter: цвет заливки `--accent` / `--status-warn` / `--status-critical`, у `warn`/`critical` рядом `CircleAlert`. Лимиты красятся по тому же правилу.
  - `ContextBanner({ percent, onCompact })` при `critical`: `context-banner` «Контекст почти заполнен — 92%» и кнопка `context-compact` «Сжать сейчас» → `window.qclod.send(tabId, { text: '/compact', attachments: [] })`.

- [ ] **Step 1: Падающие тесты**

```ts
// contextLevel.test.ts
test.each([[79, 'ok'], [80, 'warn'], [89, 'warn'], [90, 'critical'], [100, 'critical']])('%i%% → %s', (p, l) =>
  expect(contextLevel(p)).toBe(l))
// panelVisibility.test.ts
test('узкое окно прячет панель, даже если она включена', () =>
  expect(panelVisible({ setting: true, width: 1000, override: null })).toBe(false))
test('ручное открытие в узком окне побеждает', () =>
  expect(panelVisible({ setting: true, width: 1000, override: 'open' })).toBe(true))
```

```ts
// statusline.spec.ts
test('у поля всегда видны контекст и оба лимита', async () => {
  // фейк contextPercent 42 → status-context «42%», status-limit-5h «13%», status-limit-7d «38%»
})
test('80% — индикатор меняет уровень, 92% — плашка «Сжать сейчас» отправляет /compact', async () => {
  // contextPercent 82 → status-context [data-level="warn"], context-banner нет
  // contextPercent 92 → context-banner видна; клик context-compact → в ленте пузырь «/compact»
})
test('модель, усилие и режим меняются из строки статуса', async () => {
  // status-model → «Sonnet 5»; status-effort → «low»; status-mode → «план»; панель (если открыта) согласна
})
test('окно уже 1100px — панель свёрнута, переключатели в строке статуса', async () => {
  // app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
  // side-panel скрыта, status-model видна; кнопка panel-open открывает панель
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/contextLevel.test.ts tests/unit/panelVisibility.test.ts && npm run build:e2e && npx playwright test tests/e2e/statusline.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Фейку нужен способ менять процент контекста между ходами: `contextPercentByTurn?: number[]` (i-й ответ `getContextUsage` после i-го хода); описать в README.

- [ ] **Step 4: Прогнать** `statusline.spec.ts`, `panel.spec.ts`, `planmode.spec.ts`, `resumedPanel.spec.ts`, юнит. Тест Task 4 «переживает перезапуск» перевести на `status-*` здесь же.

- [ ] **Step 5: Коммит**

```bash
git add -A src tests
git commit -m "feat: a status line by the input with mode, model, effort, context and limits"
```

---

### Task 16: Разбивка контекста в панели — одна полоса и легенда (5.5, dataviz)

**Files:**
- Create: `src/renderer/panel/contextSegments.ts`, `src/renderer/components/ContextBreakdown.tsx`
- Modify: `src/shared/types.ts` (`ContextInfo.categories[].kind?: 'used' | 'free' | 'buffer'`), `src/main/agent/panelData.ts` (`setContext` оставляет `used`, `free`, `buffer`; `deferred` отбрасывает), `SidePanel.tsx`, `SidePanel.css`, `tests/fixtures/fake-sdk/index.mjs` (строки `free` и `buffer` в `getContextUsage`)
- Test: `tests/unit/contextSegments.test.ts`, `tests/unit/panelData.test.ts`, `tests/e2e/panel.spec.ts`

**Interfaces:**
- Produces:
  - `Segment { name: string; tokens: number; share: number; fill: 'seg-1' | 'seg-2' | 'seg-3' | 'seg-4' | 'seg-5' | 'seg-6' | 'seg-free' | 'seg-buffer' }`
  - `contextSegments(categories: ContextInfo['categories'], max: number): Segment[]` — строки `used` с токенами > 0 по порядку CLI получают `seg-1…seg-6`, седьмая и дальше складываются в «Другое» (`seg-6`); затем `buffer` (`seg-buffer`), затем `free` (`seg-free`). Нет строк `free` — остаток до `max` добавляется как «Свободно». Доли в сумме 1.
  - `ContextBreakdown({ context })`: полоса 8px, скруглённые концы, 2px зазор цвета фона между частями (`gap` у flex-ряда), часть нулевой ширины не рисуется; у полосы `role="img"` и `aria-label` со всеми частями. Под ней — легенда-таблица `context-legend` в порядке частей: образец, имя, токены (`toLocaleString('ru-RU')`), без процентов на каждой строке. Цвета — `var(--seg-*)`, текст — текстовые токены.

- [ ] **Step 1: Падающие тесты**

```ts
// contextSegments.test.ts
test('части по порядку CLI, свободное в конце, доли в сумме 1', () => {
  const s = contextSegments([{ name: 'System prompt', tokens: 3000, kind: 'used' },
    { name: 'Messages', tokens: 7000, kind: 'used' }, { name: 'Free space', tokens: 90000, kind: 'free' }], 100000)
  expect(s.map((x) => x.fill)).toEqual(['seg-1', 'seg-2', 'seg-free'])
  expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1)
})
test('седьмая строка и дальше — «Другое»', () => {})
test('нет строки free — остаток добавлен как «Свободно»', () => {})
test('нулевые строки не рисуются', () => {})
// panelData.test.ts
test('setContext сохраняет kind и отбрасывает deferred', () => {})
```

```ts
// panel.spec.ts
test('разбивка контекста — одна полоса и легенда', async () => {
  // panel-context: [data-testid="context-bar"] и context-legend со строками messages, system_prompt, «Свободно»
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/contextSegments.test.ts tests/unit/panelData.test.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces.

- [ ] **Step 4: Прогнать** юнит, `panel.spec.ts`, `resumedPanel.spec.ts` (оценка по записи — без `kind`, всё как `used`).

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: context breakdown as one segmented bar with a legend"
```

---

### Task 17: Карточка разрешения — главная и опасная кнопки, Enter / A / Esc (5.6)

**Files:**
- Modify: `src/renderer/components/PermissionCard.tsx`, `src/renderer/input/keyPrecedence.ts`, `Composer.tsx`, `ChatPane.tsx`, `src/renderer/components/Ribbon.tsx` (прокрутка к новому ожидающему разрешению), `src/main/index.ts` (окно не всплывает ради фоновой вкладки)
- Create: `src/renderer/chat/pendingPermission.ts`
- Test: `tests/unit/keyPrecedence.test.ts`, `tests/unit/pendingPermission.test.ts`, `tests/e2e/permissions.spec.ts`

**Interfaces:**
- Produces:
  - `oldestPendingPermission(items: RibbonItem[]): Extract<RibbonItem, { kind: 'permission' }> | null`.
  - `ComposerContext.pendingPermission?: boolean`; действия `'permissionAllow' | 'permissionAllowAll' | 'permissionDeny'`. Порядок правил: Esc — `closePopup` → `permissionDeny` (если ждёт разрешения) → `interrupt`; Enter без Shift при пустом поле, без вложений и с ожидающим разрешением → `permissionAllow`; физическая `KeyA` без модификаторов при пустом поле и ожидающем разрешении → `permissionAllowAll`. С текстом в поле Enter — обычная отправка (уходит в очередь, Task 21), не разрешение.
  - Карточка: «Разрешить» — `.btn-primary` (`--accent`), подпись клавиши `Enter`; «Разрешить всё такое» — обычная, `A`; «Отклонить» — `.btn-danger` (`--status-critical`), `Esc`. Клавиши показаны элементом `<kbd>`. Кнопки — `title` с клавишей.
  - Лента: появление нового `permission` в состоянии `pending` включает «следовать за низом» и прокручивает карточку в вид — она никогда не остаётся под полем ввода.
  - `index.ts`: окно показывается ради запроса разрешения, только если вкладка запроса активна; для фоновой — бейдж и уведомление (хвост v2 «permission ask showing the window for a background tab»).

- [ ] **Step 1: Падающие тесты**

```ts
// keyPrecedence.test.ts
test('Enter на пустом поле при ожидающем разрешении — разрешить', () =>
  expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ pendingPermission: true }))).toBe('permissionAllow'))
test('Enter с текстом при ожидающем разрешении — отправка, не разрешение', () =>
  expect(resolveComposerKey(key({ key: 'Enter' }), ctx({ text: 'и ещё', pendingPermission: true }))).toBe('submit'))
test('A (на русской раскладке «ф») — разрешить всё такое', () =>
  expect(resolveComposerKey(key({ key: 'ф', code: 'KeyA' }), ctx({ pendingPermission: true }))).toBe('permissionAllowAll'))
test('Esc при ожидающем разрешении — отклонить, а не прервать', () => {})
```

```ts
// permissions.spec.ts
test('Enter разрешает, инструмент выполняется', async () => {})
test('Esc отклоняет', async () => {})
test('A разрешает всё такое — второй такой же не спрашивается', async () => {})
test('карточка не прячется под полем ввода', async () => {
  // длинная лента (20 текстовых шагов) + askPermission; прокрутить ленту вверх до ответа
  // → после появления карточки её bottom <= top composer (boundingBox)
})
test('«Разрешить» — главная кнопка, «Отклонить» — опасная', async () => {
  // классы btn-primary / btn-danger
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/keyPrecedence.test.ts tests/unit/pendingPermission.test.ts && npm run build:e2e && npx playwright test tests/e2e/permissions.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces.

- [ ] **Step 4: Прогнать** `permissions.spec.ts`, `planmode.spec.ts`, `composer.spec.ts` (Esc прерывает без разрешения), юнит.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: permission cards answer with Enter, A and Esc and never hide under the input"
```

---

### Task 18: Пустая вкладка, подсказки у всех кнопок, уборка мёртвого (5.6)

**Files:**
- Create: `src/renderer/components/EmptyTab.tsx`, `EmptyTab.css`
- Modify: `ChatPane.tsx` (пустая лента → `EmptyTab`), `TitleBar.tsx`, `TabStrip.tsx`, `Composer.tsx` (скрепка → `Paperclip`, отправка → `ArrowUp`, стоп → `Square`), `SidePanel.tsx`, `App.tsx` (устаревшие комментарии про «Task 10/11/12», пустые строки, дубль `onConfigure`/`onOpenSettings`)
- Test: `tests/e2e/keyboard.spec.ts` (подсказки), `tests/e2e/history.spec.ts` (пустая вкладка)

**Interfaces:**
- Consumes: `hint()` и `APP_ACTIONS` (Task 7), `PathLink` (Task 11), `window.qclod.listHistory`, `openHistory`.
- Produces:
  - `EmptyTab({ tabId, cwd, onOpenSession })` (`empty-tab`): папка вкладки (`PathLink`), до 5 последних разговоров этой папки (`empty-recent`, клик открывает), подсказки `empty-tips`: «`/` — команды», «`@` — файлы», «Ctrl+K — действия», «Shift+Tab — режим разрешений». Разговоров нет — строки нет, не «пусто».
  - У каждой кнопки окна непустой `title`; у кнопок с горячей клавишей — `hint(label, id)`. `aria-label` остаётся.

- [ ] **Step 1: Падающие тесты**

```ts
// keyboard.spec.ts
test('у каждой видимой кнопки есть подсказка, у кнопок с клавишей — с клавишей', async () => {
  const buttons = await win.locator('button:visible').all()
  for (const b of buttons) expect((await b.getAttribute('title'))?.trim()).toBeTruthy()
  expect(await win.locator('[data-testid="tab-new"]').getAttribute('title')).toContain('Ctrl+T')
})
// history.spec.ts
test('пустая вкладка показывает папку, прошлые разговоры и подсказки', async () => {
  // QCLOD_FAKE_HISTORY с двумя сессиями → empty-tab, два empty-recent, empty-tips с «Ctrl+K»;
  // клик по разговору открывает его
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npm run build:e2e && npx playwright test tests/e2e/keyboard.spec.ts tests/e2e/history.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Кнопки, которые трогаются, получают Lucide-значки вместо глифов.

- [ ] **Step 4: Прогнать** весь e2e (`npm run test:e2e`) — подсказки и значки задевают много экранов.

- [ ] **Step 5: Коммит**

```bash
git add -A src tests
git commit -m "feat: an empty tab that helps you start, tooltips on every button, dead code removed"
```

---

### Task 19: Вставка картинок Ctrl+V — превью и настоящая картинка агенту (5.7.1)

Сейчас картинка из буфера уже уходит base64-блоком, но в поле — только подпись «image.png», в ленте — слово «изображение», размер не ограничен (снимок 4K легко больше 5 МБ, которые принимает API), `imagePaste.ts` не используется.

**Files:**
- Create: `src/main/files/prepareImage.ts`
- Modify: `src/main/files/imagePaste.ts` (`isInsidePasteDir`), `src/shared/types.ts` (`Attachment` image: `path?`, `thumbnail?`, `width?`, `height?`; `PreparedImage`), `src/shared/channels.ts` (`filesPrepareImage 'files:prepareImage'`), `src/main/agentIpc.ts` или `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/tabs/sanitize.ts` (`sanitizeInput` пропускает `thumbnail` — только `data:image/…`, ≤ 200 000 символов; `path` — только внутри `pastes`), `src/main/index.ts` (`cleanupPasteDir(userData)` при старте), `src/renderer/input/attachments.ts`, `Composer.tsx` (миниатюра в плашке), `RibbonItem.tsx` (миниатюра в пузыре), `tests/fixtures/fake-sdk/index.mjs` (шаг `reportInput`)
- Test: `tests/unit/prepareImage.test.ts`, `tests/unit/imagePaste.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/unit/fakeSdk.test.ts`, `tests/e2e/input.spec.ts` (новый)

**Interfaces:**
- Produces:
  - `MAX_IMAGE_SIDE = 2000`, `MAX_IMAGE_BYTES = 3_750_000` (base64 таких байт — около 5 МБ, предел API); `fitWithin(width: number, height: number, max: number): { width: number; height: number }` — чистая, сохраняет пропорции.
  - `prepareImage(userData: string, dataBase64: string, mediaType: string): PreparedImage | { error: string }` — `nativeImage.createFromBuffer`; пустая — `{ error: 'Не похоже на картинку' }`; больше `MAX_IMAGE_SIDE` — `resize(fitWithin(...))`; PNG больше `MAX_IMAGE_BYTES` — JPEG качества 85; миниатюра — `resize` до 160 по большей стороне, `toDataURL()`; файл — `saveImageBuffer(userData, buffer)`.
  - `PreparedImage { mediaType: string; dataBase64: string; thumbnail: string; path: string; width: number; height: number }`.
  - `isInsidePasteDir(userData: string, path: string): boolean`.
  - `PendingAttachment` image получает `prepared?: PreparedImage`; `attachmentsFromClipboard` не меняется, а `Composer` сразу после вставки зовёт `window.qclod.prepareImage`, показывает плашку `composer-chip` с `<img data-testid="composer-chip-thumb">`, `title` «Снимок 2000×1333» и крестиком; ошибка — плашка с текстом ошибки, без отправки. `materialize` берёт `prepared`.
  - Пузырь пользователя: картинки — миниатюры `row-user-image` (из `thumbnail`, иначе из `data:` base64, высота 96px), клик по миниатюре с `path` → `window.qclod.openPath`. `files:open` принимает путь из `pastes` (Task 10).
  - Фейк: шаг `{ kind: 'reportInput' }` — текст агента «картинок: N; типы: image/png; байт: M» по последнему `send`.

- [ ] **Step 1: Падающие тесты**

```ts
// prepareImage.test.ts
test('fitWithin уменьшает большую сторону до предела, сохраняя пропорции', () =>
  expect(fitWithin(3000, 2000, 2000)).toEqual({ width: 2000, height: 1333 }))
test('маленькая картинка не растягивается', () => expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 }))
// imagePaste.test.ts
test('isInsidePasteDir: внутри — да, соседняя папка с похожим именем — нет', () => {})
// ipcValidation.test.ts
test('миниатюра только data:image и не длиннее предела; path только из pastes', () => {})
```

```ts
// input.spec.ts
test('Ctrl+V скриншота — миниатюра в поле, крестик убирает', async () => {
  // app.evaluate(({ clipboard, nativeImage }) => clipboard.writeImage(nativeImage.createFromBitmap(
  //   Buffer.alloc(64 * 48 * 4, 200), { width: 64, height: 48 })))
  // input.press('Control+V') → composer-chip-thumb видна; клик composer-chip-remove → плашек нет
})
test('картинка уходит агенту настоящим вложением и видна в пузыре', async () => {
  // nextTurn [{ kind: 'reportInput' }] → вставить, Enter → ribbon содержит «картинок: 1»,
  // row-user-image видна
})
test('большой снимок уменьшается до 2000 по большей стороне', async () => {
  // bitmap 3000×2000 → title плашки содержит «2000×1333»
})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/prepareImage.test.ts tests/unit/imagePaste.test.ts tests/unit/ipcValidation.test.ts && npm run build:e2e && npx playwright test tests/e2e/input.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Вставка файлов из проводника не меняется (`composer.spec.ts` это держит).

- [ ] **Step 4: Прогнать** юнит, `input.spec.ts`, `composer.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: pasted screenshots show as thumbnails and reach the agent at a size it accepts"
```

---

### Task 20: История ввода по ↑/↓ — прошлые сообщения вкладки, черновик не теряется (5.7.3)

Сейчас история живёт в `useRef` одного `Composer` (пропадает с перезапуском), ↑ срабатывает только при каретке в позиции 0, а ↓ после самой новой записи стирает черновик.

**Files:**
- Modify: `src/renderer/input/history.ts`, `src/renderer/input/keyPrecedence.ts` (`caretOnFirstLine`/`caretOnLastLine` вместо `caretAtStart`/`caretAtEnd`), `Composer.tsx`, `ChatPane.tsx` (передать тексты пузырей пользователя)
- Test: `tests/unit/history.test.ts`, `tests/unit/keyPrecedence.test.ts`, `tests/e2e/input.spec.ts`

**Interfaces:**
- Produces:
  - `InputHistory`: `constructor(entries: string[] = [], limit = 500)`; `setEntries(entries: string[]): void` (старые → новые; сохраняет позицию просмотра, если просмотр не идёт); `prev(draft: string): string | undefined` — на первом шаге запоминает `draft`; `next(): string | undefined` — после самой новой записи возвращает запомненный черновик; `reset()`.
  - Записи = тексты `user`-элементов ленты вкладки (в том числе восстановленные из записи) + отправленные в этой сессии; подряд одинаковые схлопываются. Хранится в сторе по вкладке (`historyByTab` не нужен — считается из ленты).
  - ↑ — история, если каретка на первой строке поля (до первого `\n`) и нет выделения; ↓ — если на последней строке.

- [ ] **Step 1: Падающие тесты**

```ts
// history.test.ts
test('↓ после самой новой записи возвращает черновик, а не пустую строку', () => {
  const h = new InputHistory(['раз', 'два'])
  expect(h.prev('недописанное')).toBe('два'); expect(h.next()).toBe('недописанное')
})
test('записи из ленты: старые первыми, ↑ даёт самую новую', () => {})
// keyPrecedence.test.ts
test('↑ на первой строке многострочного поля — история', () =>
  expect(resolveComposerKey(key({ key: 'ArrowUp' }), ctx({ text: 'а\nб', caretOnFirstLine: true }))).toBe('historyPrev'))
test('↑ на второй строке — движение каретки', () => {})
```

```ts
// input.spec.ts
test('↑ приносит прошлое сообщение, ↓ возвращает черновик', async () => {
  // отправить «первое», «второе»; набрать «черновик»; Home; ↑ → «второе»; ↑ → «первое»; ↓ ↓ → «черновик»
})
test('история вкладки — из её ленты, у второй вкладки своя', async () => {})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/history.test.ts tests/unit/keyPrecedence.test.ts && npm run build:e2e && npx playwright test tests/e2e/input.spec.ts -g "↑|история"`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces.

- [ ] **Step 4: Прогнать** юнит, `input.spec.ts`, `composer.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests
git commit -m "feat: input history per tab from its own messages, the draft is never lost"
```

---

### Task 21: Очередь сообщений, пока агент работает (5.7.3)

**Files:**
- Create: `src/renderer/components/QueueStrip.tsx`
- Modify: `src/shared/types.ts` (`PanelData.queue`), `src/main/agent/panelData.ts` (`EMPTY_PANEL.queue = []`, `setQueue`), `src/renderer/state/useAppStore.ts` (`EMPTY_PANEL`), `src/main/agent/AgentSession.ts` (`send`, `interrupt`, `onMessage` на `result`, `takeQueue`, `requeue`), `src/main/tabs/TabController.ts` (`restart` переносит очередь), `src/shared/channels.ts` (`agentQueueCancel 'agent:queueCancel'`), `src/main/agentIpc.ts` (`agentInterrupt` возвращает очередь), `src/preload/index.ts`, `ChatPane.tsx`, `tests/fixtures/fake-sdk/index.mjs` (`turns`)
- Test: `tests/unit/agentSession.test.ts`, `tests/unit/tabController.test.ts`, `tests/unit/fakeSdk.test.ts`, `tests/e2e/input.spec.ts`

**Interfaces:**
- Produces:
  - `QueuedMessage { id: string; text: string; attachments: number }`; `PanelData.queue: QueuedMessage[]`.
  - `AgentSession.send(input)`: при статусе `busy`/`waiting` — в очередь (`randomUUID()`), в ленту **не** попадает, панель получает `queue`; иначе — как сейчас. На `result` (ход кончился, статус `idle`) уходит первое из очереди — через обычный путь `send` (пузырь появляется в этот момент).
  - `cancelQueued(id: string): boolean`.
  - `interrupt(): Promise<UserInput[]>` — отменяет ожидания (с ограничением по ходу из Task 0), прерывает, **очищает очередь и возвращает её**; IPC `agentInterrupt` отдаёт этот массив, `ChatPane` возвращает тексты в черновик (через пустую строку, перед тем, что уже набрано), а вложения — в плашки (файлы — путями, картинки — `File` из base64 с `prepared`).
  - `takeQueue(): UserInput[]` и `requeue(inputs: UserInput[]): void`; `TabController.restart(id)` берёт очередь у старой сессии до `dispose` и отдаёт новой после `start()`; упавшая сессия (`error`) очередь держит и ничего из неё не шлёт.
  - Фейк: `turns?: FakeStep[][]` — i-й ход играет `turns[i]`, иначе `nextTurn`.
  - `QueueStrip({ queue, onCancel })` — над полем: `queue-item` «В очереди: «текст»» с крестиком `queue-cancel` (`X`, `title` «Убрать из очереди»).

- [ ] **Step 1: Падающие тесты**

```ts
// agentSession.test.ts
test('сообщение во время хода ждёт в очереди и уходит после result', async () => {
  // turns: [[textStream pauseMs 50 ×5], [text 'второй ответ']]
  // send('раз'); send('два') пока busy → driver.sent.length === 1, panel.queue.length === 1
  // после первого result → driver.sent[1].text === 'два', panel.queue === []
})
test('отменённое из очереди не уходит', async () => {})
test('Стоп возвращает очередь и очищает её', async () => {
  expect(await session.interrupt()).toEqual([{ text: 'два', attachments: [] }])
})
test('упавшая сессия очередь держит и не шлёт', async () => { /* crash шаг → status error, queue.length 1, sent 1 */ })
// tabController.test.ts
test('перезапуск после падения отправляет очередь новой сессии', async () => {})
```

```ts
// input.spec.ts
test('пока агент отвечает, Enter ставит сообщение в очередь; оно уходит само', async () => {
  // queue-item «В очереди: «и потом закоммить»» → после ответа пузырь «и потом закоммить» и queue-item нет
})
test('крестик убирает из очереди', async () => {})
test('Esc возвращает очередь в поле ввода', async () => {})
```

Тест Review Focus 4 (`упавшая сессия очередь держит`, `перезапуск … отправляет`) обязателен.

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/agentSession.test.ts tests/unit/tabController.test.ts tests/unit/fakeSdk.test.ts -t "очеред|turns"`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces. Ответ на вопрос карточкой во время хода (`answerQuestion` запасным путём) идёт тем же `send` и тоже встаёт в очередь — это правильно.

- [ ] **Step 4: Прогнать** юнит целиком, `input.spec.ts`, `composer.spec.ts` (Esc), `permissions.spec.ts`.

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: messages sent while the agent works wait in a visible queue"
```

---

### Task 22: Фоновые задачи — список, живой вывод, «Остановить» (5.7.2)

**Files:**
- Create: `src/main/agent/backgroundTasks.ts`, `src/renderer/components/BackgroundTasks.tsx`, `BackgroundTasks.css`
- Modify: `src/shared/types.ts` (`BackgroundTask`, `TaskOutput`, `PanelData.backgroundTasks`), `src/main/agent/driver.ts` (`taskOutput`, `stopTask`), `src/main/agent/sdkDriver.ts`, `src/main/agent/AgentSession.ts` (трекер в `onMessage`, `taskOutput`, `stopTask`), `src/main/agent/panelData.ts` (`EMPTY_PANEL`), `src/shared/channels.ts` (`agentTaskOutput 'agent:taskOutput'`, `agentTaskStop 'agent:taskStop'`), `src/main/agentIpc.ts`, `src/preload/index.ts`, `StatusLine.tsx` (`status-bg`), `useAppStore.ts` (`EMPTY_PANEL`), `tests/fixtures/fake-sdk/index.mjs`, `index.d.mts`, `README.md` (шаг `backgroundBash`, методы `getTaskOutput`, `stopTask`)
- Test: `tests/unit/backgroundTasks.test.ts`, `tests/unit/sdkDriver.test.ts`, `tests/unit/fakeSdk.test.ts`, `tests/unit/agentSession.test.ts`, `tests/e2e/background.spec.ts` (новый)

**Interfaces:**
- Produces:
  - `BackgroundTask { taskId: string; toolUseId?: string; type: string; description: string; command?: string; status: 'running' | 'completed' | 'failed' | 'stopped'; startedAt: number; endedAt?: number }`
  - `TaskOutput { output: string; totalBytes: number; truncated: boolean }`
  - `class BackgroundTracker { constructor(now?: () => number); apply(message: unknown): BackgroundTask[] | null; get tasks(): BackgroundTask[] }` — `null`, если список не изменился. Помнит `tool_use` `Bash` (`id → input.command`); `task_started` добавляет задачу (кроме `ambient`, `skip_transcript`, `task_type === 'local_agent'`), команду берёт по `tool_use_id`; `task_notification` / `task_updated.patch.status` (`killed` → `stopped`) ставят итог и `endedAt`; `background_tasks_changed` — замена: задача, которой нет в списке и которая ещё `running`, становится `completed` (уведомление потом может уточнить). Хранит до 20 задач, новые первыми.
  - `AgentDriver.taskOutput(taskId: string): Promise<TaskOutput | null>` и `stopTask(taskId: string): Promise<void>`. В `sdkDriver`: `stopTask` — `session.stopTask`; `taskOutput` — `(session as { getTaskOutput?: (id: string) => Promise<{ output: string; total_bytes: number; truncated: boolean }> }).getTaskOutput`, проверка `typeof … === 'function'`, иначе `null`; ошибки → `null`.
  - `AgentSession.taskOutput(taskId)`, `AgentSession.stopTask(taskId)`; IPC `agentTaskOutput(tabId, taskId)`, `agentTaskStop(tabId, taskId)` — `taskId` только из текущего списка задач вкладки.
  - Строка статуса: `status-bg` «Фоновые 2» (число работающих; есть только законченные — «Фоновые» без числа), клик — список вверх `bg-list`: `bg-task` (команда моноширинно или описание, время работы, статус), раскрытие — `bg-output` (моноширинно, прокрутка, последние 8 КиБ; опрос каждые 1000 мс, пока задача раскрыта и работает, и один раз после конца), `bg-stop` «Остановить» у работающей. `taskOutput` вернул `null` — «Вывод недоступен в этой версии Claude Code».
  - Фейк: `{ kind: 'backgroundBash'; command: string; description?: string; taskId?: string; chunks?: string[]; pauseMs?: number; finish?: 'completed' | 'failed' | null }` — `tool_use` Bash с `run_in_background: true`, `tool_result` «Command running in background with ID: <id>» и `tool_use_result {stdout:'', stderr:'', interrupted:false, backgroundTaskId}`, `system/task_started {task_id, tool_use_id, description, task_type:'local_bash', is_backgrounded:true}`, `system/background_tasks_changed`; после `result` хода — по куску из `chunks` каждые `pauseMs` (их копит `getTaskOutput`), затем `task_notification {status, output_file, summary}` и пустой `background_tasks_changed`. `stopTask(id)` — `task_notification` со `stopped` и пустой список вне очереди хода. Формы — из `sdk.d.ts`, не с живой сессии: README это прямо говорит.

- [ ] **Step 1: Падающие тесты**

```ts
// backgroundTasks.test.ts
test('task_started local_bash с командой из tool_use', () => {
  t.apply(assistantToolUse('tu1', 'Bash', { command: 'npm run dev', run_in_background: true }))
  expect(t.apply(taskStarted({ task_id: 'b1', tool_use_id: 'tu1', task_type: 'local_bash', description: 'dev' })))
    .toEqual([expect.objectContaining({ taskId: 'b1', command: 'npm run dev', status: 'running' })])
})
test('подагенты и ambient в список не попадают', () => {})
test('уведомление stopped ставит итог', () => {})
test('пропала из background_tasks_changed — completed', () => {})
// sdkDriver.test.ts
test('taskOutput зовёт getTaskOutput, если он есть', async () => {})
test('нет getTaskOutput — null без ошибки', async () => {})
```

```ts
// background.spec.ts
test('фоновая команда видна в строке статуса, вывод растёт, «Остановить» останавливает', async () => {
  // nextTurn: backgroundBash { command:'npm run dev', chunks:['готово 1\n','готово 2\n'], pauseMs:300, finish:null }
  // status-bg «Фоновые 1» → клик → bg-task «npm run dev» → раскрыть → bg-output содержит «готово 2»
  // клик bg-stop → статус задачи «остановлена», status-bg без числа
})
test('законченная задача остаётся в списке с итогом', async () => {})
```

- [ ] **Step 2: Прогнать — падает.** Run: `npx vitest run tests/unit/backgroundTasks.test.ts tests/unit/sdkDriver.test.ts tests/unit/fakeSdk.test.ts && npm run build:e2e && npx playwright test tests/e2e/background.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Реализация** — по Interfaces.

- [ ] **Step 4: Прогнать** юнит целиком, `background.spec.ts`, `statusline.spec.ts`, `chat.spec.ts` (фоновые подагенты не задеты).

- [ ] **Step 5: Коммит**

```bash
git add src tests
git commit -m "feat: background tasks with live output and a stop button"
```

---

### Task 23: Общий прогон и показ владельцу

**Files:** —

- [ ] **Step 1: Всё зелёное**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e`
Expected: 0 ошибок типов; все юнит- и e2e-тесты PASS; в выводе vitest нет «Unhandled Rejection».

- [ ] **Step 2: Нет захардкоженных цветов в новых стилях**

Run: `git diff --name-only f5ce04f..HEAD -- "src/renderer/**/*.css" | xargs grep -nE "#[0-9a-fA-F]{3,8}\b|rgba?\(" | grep -v tokens.css`
Expected: пусто (в изменённых этим этапом CSS цвета только через токены). Если что-то нашлось в старых строках, которые этап не трогал, — оставить для этапа 3 и записать в ledger.

- [ ] **Step 3: Скриншоты для владельца**

Через Playwright с фейком (как `tests/e2e/screenshot.spec.ts`) снять: ленту с карточками всех категорий и раскрытой командой и правкой; подагента с раскрытой лентой шагов; строку «сейчас» с «2 агента»; полоску задач; список `/` над полем и второй шаг `/model`; меню пути; строку статуса на 82% и плашку на 92%; панель с полосой разбивки; карточку разрешения; пустую вкладку; список фоновых задач. Сохранить в `docs/superpowers/notes/stage2-screens/`.

- [ ] **Step 4: Показать и ждать**

Отдать владельцу скриншоты и короткий список, что изменилось и где пробелы (код выхода Bash и `getTaskOutput` не из типов SDK). Этап считается принятым только после его оценки в работающем приложении; к этапу 3 не переходить до неё.
