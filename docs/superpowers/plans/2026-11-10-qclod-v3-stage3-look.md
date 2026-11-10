# Qclod v3 — Этап 3: внешний вид. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qclod выглядит как строгий непрозрачный графитовый инструмент в духе Linear/Raycast: один яркий акцент, Inter для прозы и Geist Mono только для кода, шесть ступеней шрифта, Lucide везде, фокус виден везде, текст выделяется там, где его копируют, у каждого экрана есть загрузка, пусто и ошибка — и всё это проверяется тестами, а не на глаз.

**Architecture:** Вид держится на одном файле — `src/renderer/styles/tokens.css`. Этап 2 уже перевёл компоненты на роли-токены (`--cat-*`, `--status-*`, `--seg-*`, размеры строк и чипов); этап 3 меняет **значения** токенов и вычищает остатки старого «стекла»: прозрачные поверхности, акрил окна, `--glow*`, `backdrop-filter`, захардкоженные цвета и px-размеры шрифта. Правила, которые раньше держались на внимании ревьюера, становятся статическими юнит-тестами над CSS (контраст, расстояние между цветами категорий, шкала шрифта, запрет hex/`outline: none`/`uppercase`/Unicode-глифов) и e2e-проверками на живом окне (фон окна, шрифты, кольцо фокуса, выделение, контраст каждого видимого текста). Общий компонент `StateView` даёт всем экранам одинаковые загрузку, пусто и ошибку.

**Tech Stack:** Electron 33, electron-vite 2, React 18, TypeScript 5, zustand 5, `lucide-react` **1.62.0**, **`@fontsource-variable/inter` 5.3.0** и **`@fontsource-variable/geist-mono` 5.3.0** (новые, точные версии, проверены `npm view` 2026-11-10), Vitest 2, Playwright (`_electron`) против `tests/fixtures/fake-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-10-qclod-v3-design.md` — раздел 6 целиком, анти-цель «снова стекло и неон» из раздела 3 и ограничения раздела 9. Плюс отложенные визуальные хвосты этапа 2 из `.superpowers/sdd/2026-11-10-qclod-v3-stage2-chat/progress.md` (Task 1, 5, 7, 9, 16, 18).

## Global Constraints

- Платформа — только Windows 11 x64. Тема — только тёмная; токены — роли, чтобы светлую можно было добавить потом (спека, раздел 3).
- **Каждая задача начинается с падающего теста** (юнит над CSS/кодом или e2e против фейка). Шаг «прогнать, убедиться что падает» не пропускается; тест, который проходит на текущем коде, переписывается.
- Сквозные тесты — **только с `QCLOD_FAKE_SDK`** (его ставит `playwright.config.ts`), никогда против настоящего агента. Новый шаг фейка или новый тестовый шов — строка в `tests/fixtures/fake-sdk/README.md` и в `scripts/check-release-seams.mjs` (релизная сборка не должна их содержать).
- **Этап 2 ещё доделывается параллельно** (Task 20 история ввода, 21 очередь, 22 фоновые задачи, 23 итог). План ссылается на компоненты по имени, не по строкам. Перед каждой задачей: `git log -5 --oneline`, затем **заново прочитать** каждый файл, который задача трогает; новые компоненты этапа 2 (`QueueStrip`, список фоновых задач и т. п.), появившиеся к этому моменту, попадают под те же правила, что и остальные — статические тесты их и так поймают.
- Весь текст для пользователя — по-русски, просто, без воды, обычный регистр предложения. Ошибка говорит, что случилось и что делать; без извинений.
- Цвета, размеры шрифта, межстрочные, радиусы, тени — **только через `var(--…)`** из `tokens.css`. Значения живут только в `tokens.css` (и `WINDOW_BG` в `src/shared/theme.ts`, сверяемый тестом).
- Иконки — только `lucide-react@1.62.0`. Unicode-глифы как значки запрещены (типографские `×` в «1920×1080», `…`, стрелки в комментариях — можно).
- Цвет никогда не единственный носитель смысла: у категории — значок и название, у статуса (`ok/warn/critical`) — **свой** значок и подпись (dataviz: «status ships with an icon + label»).
- Текст красится текстовыми токенами (`--text`, `--text-dim`, `--text-faint`), а не цветом категории или статуса (dataviz: «text wears text tokens»). Исключение — подсветка кода `--syn-*`.
- Никакой прозрачности поверхностей, акрила, `backdrop-filter`, свечения (`--glow*`), градиентов как украшения (спека 6, анти-цель раздела 3). Полупрозрачность допустима только для затемнения под модальным окном (`--backdrop`) и для тонировок `color-mix` поверх непрозрачного фона.
- В сообщениях коммитов **нет** подписей соавторов и упоминаний Claude/ИИ. Коротко, в стиле истории: `feat: …`, `fix: …`, `style: …`, `test: …`.
- Скриншоты каждой задачи — в `C:\Users\user\AppData\Local\Temp\claude\b4ba85a236a252e7\b03a667e-aa34-4cdf-b322-bcee1b3ea39e\scratchpad\stage3\` через помощника `shot()` (Task 2); путь передаётся переменной `QCLOD_SHOT_DIR`, без неё снимки идут в `tests/.artifacts/shots/` (в `.gitignore`).
- Дизайн-инструменты обязательны (спека 6): исполнитель каждой задачи с видом читает `frontend-design`, для индикаторов — `dataviz` (и запускает его `validate_palette.js` при любой смене `--cat-*`/`--seg-*`), плотность — через `playground` (Task 1); ревью задач — `pr-review-toolkit`; `ui-ux-pro-max` — если владелец его поставил.
- Приложение для проверки руками **не запускается**; всё видимое — через Playwright с фейком.
- Порядок: Task 1–12 по номерам. Ветка — `feat/qclod-v2`. Проверка: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`; один файл e2e: `npm run build:e2e && npx playwright test tests/e2e/<file>.spec.ts`.

## Review Focus

1. **Текст на тонированной заливке** (чип категории 18%, плашка ошибки, выбранная строка меню, `--accent-fill`) — контраст считается не к голой поверхности, а к смеси; ожидается ≥ 4.5:1 и там. Ловит e2e-аудит контраста (Task 10), которому помощник смешивает полупрозрачные фоны с родителями.
2. **Кириллица в моноширинном** (путь `C:\Users\Иван\проект`, вывод команды по-русски) — должна рисоваться Geist Mono, а не откатываться на Consolas посреди строки. Тест в Task 3 проверяет, что подмножество `cyrillic` шрифта загрузилось на строке с кириллицей.
3. **Фокус после закрытия модального окна** (Esc в настройках, истории, палитре) — кольцо фокуса возвращается на кнопку, которая окно открыла, а не пропадает на `body`. Тест в Task 6.
4. **Окно на минимальном размере 800×600** — новая шкала шрифта и отступы не дают горизонтальной прокрутки и обрезанных кнопок в строке статуса и заголовке. Снимок и проверка `scrollWidth <= clientWidth` в Task 12.
5. **Масштаб Ctrl+= / Ctrl+-** (добавлен в этапе 2) — кольцо фокуса и полосы индикаторов остаются видимыми при 80% и 125%; размеры в токенах — px, масштаб их честно умножает. Проверка в Task 6 (фокус при zoom 0.8).

---

## Решения по виду (frontend-design + playground + dataviz)

Направление задано спекой — Linear/Raycast: строго, плотно, быстро. Свобода у исполнителя — в оттенках, шкале и плотности.

**Что запоминается.** Одна вещь, как и в этапе 2, — живая строка «сейчас» над полем ввода (значок категории, глагол прозой, объект моноширинно, таймер). Второй «голос» — чёткое акцентное кольцо фокуса: оно и есть «всё с клавиатуры», видимое. Всё остальное — тихое: поверхности различаются ступенью серого, а не тенью; тени только у всплывающего (меню, модальные окна).

**Проверка плана против брифа (что изменил и почему):**
- Акцент индиго `#5e6ad2` — это цвет самого Linear; копия чужого бренда. Взял более холодный и светлый кобальт `#5a8bff`.
- Фиолетовый акцент отвергнут: категория «Агент» по спеке фиолетовая, а «План/вопрос» по спеке — цвет акцента; в этапе 2 они уже были слишком близки (ΔE 12.7). Синий акцент + светлая лаванда агента дают ΔE ≥ 16 (валидатор dataviz, см. ниже).
- Метка в заголовке с градиентом и свечением — прямой «неон»; станет сплошным квадратом акцента.
- Заголовки разделов КАПСОМ с разрядкой (`App.css`, `SidePanel.css`, `Ribbon.css`, `Markdown.css`) — шаблонный приём; заменяются обычным регистром, весом 600 и цветом `--text-dim`.
- «Тинтованный почти-чёрный» `#0b0b0b`-подобный фон не берём: ступени из спеки (`#0f0f11` → `#26262d`) — честный нейтральный графит с лёгким холодом.

### Палитра

| Токен | Значение | Роль и проверка |
|---|---|---|
| `--bg` | `#0f0f11` | Фон окна, заголовок, утопленные области (код, поле ввода). Совпадает с `WINDOW_BG` |
| `--surface` | `#16161a` | Лента, панель, вкладки |
| `--surface-raised` | `#1d1d22` | Карточки, меню, модальные окна |
| `--surface-hover` | `#26262d` | Наведение, выбранная строка |
| `--border` | `#26262d` | Линии разделения |
| `--border-strong` | `#34343d` | Граница полей и кнопок |
| `--text` | `#ececf1` | 15.3:1 к `--surface` |
| `--text-dim` | `#a1a1ab` | 6.6:1 к `--surface-raised` |
| `--text-faint` | `#8a8a95` | 4.9:1 к `--surface-raised` (было 3.4 — хвост Task 1 этапа 2 закрыт) |
| `--accent` | `#5a8bff` | Главное действие, фокус, «План/вопрос». 5.3:1 к `--surface-raised` |
| `--on-accent` | `#0b0d14` | Текст на заливке акцента, 6.1:1 |
| `--cat-read` | `#9b9ba6` | Нейтральный серый |
| `--cat-search` | `#40c3dd` | Бирюзово-голубой |
| `--cat-edit` | `#6cc35b` | Зелёный |
| `--cat-command` | `#e6a03c` | Янтарный |
| `--cat-agent` | `#d4aaff` | Светлая лаванда (отодвинута от акцента светлотой) |
| `--cat-mcp` | `#f2689a` | Розовый |
| `--cat-plan` | `var(--accent)` | |
| `--cat-other` | `var(--text-faint)` | Теперь ≥ 4.5:1 — значок можно ставить и рядом с текстом |
| `--status-ok` | `#4cc38a` | Мятный, отличается от `--cat-edit` |
| `--status-warn` | `#f5c04a` | |
| `--status-critical` | `#ff6369` | 5.8:1 к `--surface-raised` (было 4.3) |
| `--meter-track` | `#3a3a44` | Заливки индикаторов к треку ≥ 3:1 (WCAG 1.4.11) |
| `--syn-keyword` / `--syn-string` / `--syn-number` / `--syn-type` | `#c9a6ff` / `#9fd67f` / `#f0b45a` / `#7cc8f0` | Подсветка кода, ≥ 8:1 к `--bg` |
| `--syn-comment` / `--syn-punct` | `var(--text-faint)` / `var(--text-dim)` | |
| `--seg-1…6` | без изменений | Полоса разбивки контекста (график): валидатор dataviz на `#16161a` — PASS по всем пяти проверкам |

Все цвета текста и значков (кроме треков) — ≥ 4.5:1 к `--bg`, `--surface`, `--surface-raised`; `--text` и `--text-dim` — ещё и к `--surface-hover`. Значения посчитаны скриптом при написании плана; тест Task 1 пересчитывает их при каждой правке.

**Валидатор dataviz по категориям** (`validate_palette.js "#5a8bff,#40c3dd,#6cc35b,#e6a03c,#d4aaff,#f2689a" --mode dark --surface "#16161a" --pairs all`): нормальное зрение — худшая пара ΔE 17.1 (PASS, ≥ 15); контраст — PASS; светлотная полоса «для графиков» (0.48–0.67) — FAIL **сознательно**: это не серии графика, а значки рядом с текстом, им нужен контраст текста ≥ 4.5:1 (спека 6), а он требует L ≈ 0.7. CVD — FAIL у пары «Правка/Команда» (зелёный/янтарный, ΔE 4.7 для дейтанопии): цвета заданы спекой, вторичное кодирование обязательно и уже есть — у каждой категории свой значок и название, у правки ещё «+12 −3». Записать это решение в ledger в Task 1.

### Шрифты

- **Inter** (`@fontsource-variable/inter`, семейство `"Inter Variable"`) — проза и интерфейс. Выбран вместо Geist Sans из-за кириллицы: интерфейс целиком русский, у Inter одна из лучших кириллиц среди открытых гротесков, с вариативной осью веса.
- **Geist Mono** (`@fontsource-variable/geist-mono`, семейство `"Geist Mono Variable"`) — только код, пути, команды, вывод, сочетания клавиш. Пакет с подмножеством `cyrillic`; нынешний `src/renderer/assets/fonts/GeistMono.woff2` удаляется.
- Оба шрифта ложатся в сборку как файлы (`font-src 'self'` в CSP уже стоит), сеть во время работы не нужна.
- Цифры в таймерах, процентах, счётчиках — `font-variant-numeric: tabular-nums`, чтобы не дрожали.

### Шкала (6 ступеней) и ритм

| Токен | px | Где |
|---|---|---|
| `--text-xs` | 11 | Подписи индикаторов, время в списках |
| `--text-sm` | 12 | Строка статуса, вкладки, код и вывод (моноширинный) |
| `--text-md` | 13 | Интерфейс по умолчанию (`body`), карточки, меню |
| `--text-lg` | 14 | Проза ленты (ответ агента и сообщение пользователя) |
| `--text-xl` | 16 | Заголовки модальных окон и экрана установки |
| `--text-2xl` | 20 | Заголовок пустой вкладки |

Межстрочные: `--leading-tight: 1.25` (однострочные ряды), `--leading: 1.45` (интерфейс), `--leading-prose: 1.6` (лента). Ширина прозы в ленте — `--prose-max-w: 72ch`. Веса: `--weight-regular: 400`, `--weight-medium: 500`, `--weight-strong: 600`. Нынешние 13 размеров сводятся так: 10 / 10.5 / 11 → xs; 11.5 / 12 → sm; 12.5 / 13 → md; 14 → lg; 15 / 17 → xl; 18 / 19 / 22 → 2xl (при сомнении — ступень меньше: плотность важнее).

Радиусы по иерархии, а не один на всё: `--radius-hair: 3px` (путь в тексте), `--radius-sm: 4px` (чипы, строки меню), `--radius: 6px` (кнопки, поля, карточки), `--radius-lg: 10px` (модальные окна, всплывающие списки). Тени — только у всплывающего: `--shadow-menu: 0 12px 32px rgba(0, 0, 0, 0.5)`, `--shadow-modal: 0 24px 64px rgba(0, 0, 0, 0.6)`; `--backdrop: rgba(0, 0, 0, 0.55)` без размытия.

Фокус: `--focus-ring-width: 2px`, `--focus-ring-color: var(--accent)`, `--focus-offset: 2px`, `--focus-ring: 0 0 0 var(--focus-ring-width) var(--focus-ring-color)` (кольцо-тень для контейнеров с `:focus-within`).

Ширина колонки чата: `--content-max-w: 920px`, `--content-gutter: 20px` — общие для `NowLine`, поля ввода и предупреждения о закрытии в `ChatPane` (хвост Task 7 этапа 2; `--now-max-w`/`--now-gutter` удаляются).

### Плотность — через playground

Плотность (высота строк меню и карточек, отступы) подбирается в живой песочнице по `playground` (шаблон `templates/design-playground.md`), а не на глаз в коде. Значения по умолчанию в песочнице — те, что выше и в нынешних `--menu-row-h: 28px`, `--tool-head-h: 30px`. Пресеты: «Плотно» (строка 26 / карточка 28 / шаг 4), «Обычно» (28 / 30 / 4 — по умолчанию), «Просторно» (32 / 34 / 8), «Как терминал» (24 / 24 / 4, моноширинная проза — для сравнения и чтобы убедиться, что это хуже). Песочница — исполнительский инструмент: владельцу не показывается до готового приложения (спека: «заранее нарисованные макеты — не делаем»).

### Индикаторы — dataviz

Индикаторы контекста и лимитов — «meter»: трек `--meter-track`, заливка цветом уровня (`--status-*`) только при `warn/critical`, в обычном состоянии — `--text-dim`, концы скруглены на половину высоты, подпись (процент) — текстовым токеном и `tabular-nums`, рядом значок уровня: `warn` — `TriangleAlert`, `critical` — `OctagonAlert` (разные формы, а не только оттенок — хвост Task 16 этапа 2). Полоса разбивки — без изменений по форме: 2px зазор `--surface` между сегментами, легенда всегда.

### Раскладка (не меняется по структуре — меняется материал)

```
┌ ■ Qclod │ вкладка 1 │ вкладка 2 │ +          ⫼  ⟲  ⚙   —  ☐  ✕ ┐  --bg, без размытия
├──────────────────────────────────────────────────┬──────────────┤
│  лента: проза Inter 14/1.6, ≤ 72ch, слева         │ панель       │  --surface
│  ┌ ▌[≡] Читает  src/main/index.ts        готово ┐ │ --surface    │  карточки --surface-raised
│                                                   │              │
│ ▌[⌘] Запускает  npm test           0:42  2 агента │              │  NowLine — главный акцент вида
│ ┌──────────────────────────────────────────────┐  │              │
│ │ Что делаем?                              [↑] │  │              │  поле --bg, кольцо фокуса акцентом
│ └──────────────────────────────────────────────┘  │              │
│  План ▾  Opus ▾  high ▾          ▬▬▭ 42%  5 ч 13% │              │
└──────────────────────────────────────────────────┴──────────────┘
```

Модальные окна (настройки, история, палитра) и экран установки — один «лист»: `--surface-raised`, `--radius-lg`, `--shadow-modal`, шапка с заголовком `--text-xl` и кнопкой закрытия, тело с прокруткой; поля и кнопки — общие стили `ui/controls.css` (Task 10).

---

## File Structure

| Файл | Что в нём | Задача |
|---|---|---|
| `src/renderer/styles/tokens.css` | Все значения: палитра, шкала, радиусы, тени, фокус, базовые правила `body`, `:focus-visible`, хром | 1, 2, 3, 4, 6, 7 |
| `src/shared/theme.ts` (новый) | `WINDOW_BG = '#0f0f11'` | 2 |
| `src/main/window.ts` | `mainWindowOptions()` без акрила | 2 |
| `src/renderer/main.tsx` | Импорт шрифтов | 3 |
| `src/renderer/ui/icons.tsx` | + `LEVEL_ICON`, `LevelIcon`, `CHROME_ICON_SIZE` | 8 |
| `src/renderer/ui/StateView.tsx`, `StateView.css` (новые) | Загрузка / пусто / ошибка | 9 |
| `src/renderer/ui/controls.css` (новый) | Кнопки, поля, лист модального окна | 10 |
| `src/main/testSeams/ipcFaults.ts` (новый) | Тестовые задержки и отказы IPC | 9 |
| `tests/unit/cssTokens.ts` (новый) | Разбор `tokens.css`, контраст WCAG, ΔE OKLab, обход CSS-файлов | 1 |
| `tests/unit/tokens.test.ts` | Контраст, расстояния, шкала, отсутствие старых токенов | 1, 4, 5 |
| `tests/unit/styleRules.test.ts` (новый) | Запреты над всеми CSS/TSX окна | 4, 5, 6, 8 |
| `tests/e2e/helpers/shot.ts`, `helpers/contrast.ts`, `helpers/launch.ts` (новые) | Снимки, аудит контраста, запуск с профилем и сценарием фейка | 2, 10 |
| `tests/e2e/look.spec.ts` (новый) | Окно, шрифты, фокус, выделение, значки | 2, 3, 6, 7, 8 |
| `tests/e2e/states.spec.ts` (новый) | Загрузка / пусто / ошибка экранов | 9 |
| `tests/e2e/screens.spec.ts` (новый) | Аудит контраста по экранам и итоговые снимки | 10, 12 |

---

### Task 1: Графитовая палитра и шкала в токенах, проверяемые тестом

**Files:**
- Create: `tests/unit/cssTokens.ts`
- Modify: `src/renderer/styles/tokens.css`, `tests/unit/tokens.test.ts`
- Scratch (не в репозиторий): `<QCLOD_SHOT_DIR>/playground-density.html`

**Interfaces:**
- Produces (`tests/unit/cssTokens.ts`):
  - `readTokens(css: string): Map<string, string>` — пары `--имя: значение` из `:root`.
  - `resolveColor(tokens: Map<string, string>, name: string): string` — идёт по цепочке `var(--x)` до `#rrggbb`; на `color-mix`, `rgba` и прочем бросает ошибку с именем токена.
  - `contrast(a: string, b: string): number` — WCAG 2.x по относительной яркости.
  - `deltaE(a: string, b: string): number` — евклидово расстояние в OKLab × 100 (как в `validate_palette.js` dataviz).
  - `rendererCssFiles(): string[]` — все `src/renderer/**/*.css` кроме `styles/tokens.css`; `rendererTsxFiles(): string[]` — все `src/renderer/**/*.tsx`.
  - `stripComments(css: string): string`.
- Produces (токены): всё из «Решений по виду» — `--bg`, `--surface`, `--surface-raised`, `--surface-hover`, `--border`, `--border-strong`, текстовые, `--accent`, `--on-accent`, `--cat-*`, `--status-*`, `--meter-track`, `--syn-*`, шесть `--text-*` размеров, `--leading*`, `--weight-*`, `--radius-*`, `--shadow-*`, `--backdrop`, `--focus-*`, `--content-max-w`, `--content-gutter`, `--prose-max-w`.

- [ ] **Step 1: Падающие тесты в `tests/unit/tokens.test.ts`** (существующие проверки этапа 2 оставить, кроме `--cat-other: var(--text-faint)` — она остаётся верной)

```ts
const t = readTokens(css)
const SURFACES = ['--bg', '--surface', '--surface-raised']
const TEXTISH = ['--text', '--text-dim', '--text-faint', '--accent',
  '--cat-read', '--cat-search', '--cat-edit', '--cat-command', '--cat-agent', '--cat-mcp', '--cat-plan', '--cat-other',
  '--status-ok', '--status-warn', '--status-critical']

test('поверхности — непрозрачные ступени из спеки', () => {
  expect(resolveColor(t, '--bg')).toBe('#0f0f11')
  expect(resolveColor(t, '--surface')).toBe('#16161a')
  expect(resolveColor(t, '--surface-raised')).toBe('#1d1d22')
  expect(resolveColor(t, '--surface-hover')).toBe('#26262d')
})

test.each(TEXTISH.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('%s на %s — не меньше 4.5:1', (fg, bg) => {
  expect(contrast(resolveColor(t, fg), resolveColor(t, bg))).toBeGreaterThanOrEqual(4.5)
})

test.each([['--text', '--surface-hover'], ['--text-dim', '--surface-hover'], ['--on-accent', '--accent']])(
  '%s на %s — не меньше 4.5:1', (fg, bg) => expect(contrast(resolveColor(t, fg), resolveColor(t, bg))).toBeGreaterThanOrEqual(4.5))

test.each(['--syn-keyword', '--syn-string', '--syn-number', '--syn-type', '--syn-comment', '--syn-punct'])(
  'подсветка %s читается на фоне кода', (n) => expect(contrast(resolveColor(t, n), resolveColor(t, '--bg'))).toBeGreaterThanOrEqual(4.5))

test.each(['--status-ok', '--status-warn', '--status-critical', '--text-dim'])('заливка %s видна на треке (≥ 3:1)', (n) => {
  expect(contrast(resolveColor(t, n), resolveColor(t, '--meter-track'))).toBeGreaterThanOrEqual(3)
})

test('цветные категории различимы попарно (ΔE OKLab ≥ 15), агент далеко от плана', () => {
  const cats = ['search', 'edit', 'command', 'agent', 'mcp', 'plan'].map((c) => resolveColor(t, `--cat-${c}`))
  for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) {
    expect(deltaE(cats[i], cats[j])).toBeGreaterThanOrEqual(15)
  }
})

test('шкала шрифта — ровно шесть ступеней', () => {
  const sizes = [...t].filter(([k, v]) => k.startsWith('--text-') && /px$/.test(v))
  expect(Object.fromEntries(sizes)).toEqual({
    '--text-xs': '11px', '--text-sm': '12px', '--text-md': '13px',
    '--text-lg': '14px', '--text-xl': '16px', '--text-2xl': '20px'
  })
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/tokens.test.ts`
Expected: FAIL — нет `cssTokens.ts`, нет `--bg`, `--surface` — `rgba(...)`, `--text-faint` 3.4:1, агент/план ΔE 12.7, нет `--text-2xl`.

- [ ] **Step 3: Подобрать плотность в playground**

Собрать одним HTML-файлом по `playground` (шаблон `design-playground.md`) песочницу в `<QCLOD_SHOT_DIR>/playground-density.html`: слева ползунки (высота строки меню, высота карточки, шаг отступа, размер прозы lg 13/14/15) и переключатели палитры (значения из таблицы), справа живой макет нижней части чата (карточки всех категорий, `NowLine`, поле ввода, строка статуса с индикаторами 42% / 82% / 92%) на `#16161a`, внизу — текст-подсказка с копированием. Четыре пресета из «Решений по виду». Выбранные значения (если отличаются от плана) записать одной строкой в ledger и использовать в Step 4. Файл не коммитится.

- [ ] **Step 4: Переписать `:root` в `tokens.css`**

Значения — из таблиц «Решений по виду». Роли `--surface`/`--surface-raised`/`--text*`/`--accent`/`--border*` сохраняют имена (на них стоят компоненты). Удаляемые позже токены (`--surface-sunken`, `--glow`, `--glow-accent`, `--glow-soft`, `--menu-blur`, `--now-max-w`, `--now-gutter`, `--ok`, `--warn`, `--danger`) пока остаются **алиасами на новые роли** с комментарием `/* removed in Task 5 */`: `--surface-sunken: var(--bg)`, `--glow: var(--accent)`, `--glow-accent: var(--focus-ring)`, `--glow-soft: none`, `--menu-blur: 0px`, `--now-max-w: var(--content-max-w)`, `--now-gutter: var(--content-gutter)`, `--ok: var(--status-ok)`, `--warn: var(--status-warn)`, `--danger: var(--status-critical)`. Старые размеры шрифта тоже становятся алиасами нужной ступени до Task 4.

- [ ] **Step 5: Прогнать — проходит, остальное не сломано**

Run: `npx vitest run tests/unit/tokens.test.ts && npm run typecheck && npm run test:unit`
Expected: PASS, 0 ошибок типов.

- [ ] **Step 6: Коммит**

```bash
git add src/renderer/styles/tokens.css tests/unit/cssTokens.ts tests/unit/tokens.test.ts
git commit -m "style: graphite palette and six-step type scale, checked for contrast"
```

---

### Task 2: Непрозрачное окно без акрила

**Files:**
- Create: `src/shared/theme.ts`, `tests/e2e/helpers/shot.ts`, `tests/e2e/helpers/launch.ts`, `tests/e2e/look.spec.ts`
- Modify: `src/main/window.ts`, `src/renderer/styles/tokens.css` (правило `body`), `src/renderer/app/App.css` (`.app`), `tests/unit/smoke.test.ts`
- Test: `tests/unit/window.test.ts` (новый), `tests/e2e/look.spec.ts`

**Interfaces:**
- Produces:
  - `export const WINDOW_BG = '#0f0f11'` в `src/shared/theme.ts`.
  - `export function mainWindowOptions(): BrowserWindowConstructorOptions` в `window.ts`; `createMainWindow()` вызывает `new BrowserWindow(mainWindowOptions())`.
  - `shot(win: Page, name: string): Promise<void>` — `win.screenshot({ path: join(process.env.QCLOD_SHOT_DIR ?? 'tests/.artifacts/shots', name + '.png') })`, папку создаёт.
  - `launchQclod(opts?: { script?: unknown; env?: Record<string, string>; size?: { width: number; height: number } }): Promise<{ app: ElectronApplication; win: Page; profile: string }>` — свежий `QCLOD_USER_DATA` (mkdtemp), `QCLOD_FAKE_SDK_SCRIPT` из `script`, ждёт `[data-testid="composer-input"]` или `[data-testid="setup-screen"]`; `size` — через `BrowserWindow.setSize` в `app.evaluate`. Образец — запуск в `tests/e2e/statusline.spec.ts`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/window.test.ts — electron замокан vi.mock('electron', () => ({ BrowserWindow: class {}, shell: {} }))
test('окно непрозрачное, фон — графит из токенов', () => {
  const o = mainWindowOptions()
  expect(o.backgroundMaterial).toBeUndefined()
  expect(o.transparent).not.toBe(true)
  expect(o.backgroundColor).toBe(WINDOW_BG)
  expect(readTokens(css).get('--bg')).toBe(WINDOW_BG)
})
```

В `smoke.test.ts` строку `expect(source).toContain("backgroundMaterial: 'acrylic'")` заменить на `expect(source).not.toContain('backgroundMaterial')`.

```ts
// tests/e2e/look.spec.ts
test('окно и страница непрозрачные, нигде нет размытия', async () => {
  const { app, win } = await launchQclod()
  const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
  expect(bg.toLowerCase()).toBe('#0f0f11')
  expect(await win.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 15, 17)')
  const blurred = await win.evaluate(() =>
    [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).backdropFilter !== 'none').length)
  expect(blurred).toBe(0)
  await shot(win, '02-window')
  await app.close()
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/window.test.ts tests/unit/smoke.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts`
Expected: FAIL — нет `mainWindowOptions`, фон `#00000000`, `body` прозрачный, `backdrop-filter` у меню/модальных (размытие проверяется на пустой вкладке — там его может не оказаться; тогда тест падает на цвете фона, этого достаточно).

- [ ] **Step 3: Реализация**

`window.ts`: убрать `backgroundMaterial`, `backgroundColor: WINDOW_BG`. `tokens.css`: `body { background: var(--bg); }`. `.app` в `App.css` — `background: var(--surface)` остаётся (теперь непрозрачный). `backdrop-filter` из CSS компонентов удаляется здесь же (8 файлов из `grep -rn backdrop-filter src/renderer`) — тест на размытие проверяет и их.

- [ ] **Step 4: Прогнать — проходит**

Run: та же команда, что в Step 2, с `QCLOD_SHOT_DIR` на папку скриншотов этапа.
Expected: PASS; снимок `02-window.png` — сплошной графит, обои не просвечивают.

- [ ] **Step 5: Коммит**

```bash
git add src/shared/theme.ts src/main/window.ts src/renderer tests/unit/window.test.ts tests/unit/smoke.test.ts tests/e2e/helpers tests/e2e/look.spec.ts
git commit -m "style: opaque graphite window, no acrylic or blur"
```

---

### Task 3: Inter для прозы, Geist Mono только для кода — из пакета, без сети

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/renderer/main.tsx`, `src/renderer/styles/tokens.css`, CSS компонентов с `font-family`
- Delete: `src/renderer/assets/fonts/GeistMono.woff2`
- Test: `tests/unit/tokens.test.ts`, `tests/e2e/look.spec.ts`

**Interfaces:**
- Produces: `--font-ui: 'Inter Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`; `--font-mono: 'Geist Mono Variable', 'Cascadia Mono', Consolas, ui-monospace, monospace`; `body { font-family: var(--font-ui); font-size: var(--text-md); line-height: var(--leading) }`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/tokens.test.ts
test('шрифты закреплены точными версиями и лежат в пакетах', () => {
  expect(pkg.dependencies['@fontsource-variable/inter']).toBe('5.3.0')
  expect(pkg.dependencies['@fontsource-variable/geist-mono']).toBe('5.3.0')
  expect(css).not.toMatch(/@font-face/) // шрифты приходят из пакетов
  expect(t.get('--font-ui')).toMatch(/^'Inter Variable'/)
  expect(t.get('--font-mono')).toMatch(/^'Geist Mono Variable'/)
})
```

```ts
// tests/e2e/look.spec.ts — сценарий фейка: ответ с абзацем прозы и блоком кода с путём «C:\\Users\\Иван\\проект\\файл.ts»
test('проза — Inter, код — Geist Mono с кириллицей, шрифты не из сети', async () => {
  // отправить сообщение, дождаться ответа
  const prose = await win.locator('[data-testid="assistant-text"]').first().evaluate((el) => getComputedStyle(el).fontFamily)
  const code = await win.locator('.md-code').first().evaluate((el) => getComputedStyle(el).fontFamily)
  expect(prose).toMatch(/^"?Inter Variable/)
  expect(code).toMatch(/^"?Geist Mono Variable/)
  expect(await win.evaluate(async () => { await document.fonts.ready
    return document.fonts.check('12px "Geist Mono Variable"', 'Иван') && document.fonts.check('14px "Inter Variable"', 'Привет') })).toBe(true)
  const remote = await win.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => e.name).filter((n) => /\.woff2/.test(n) && !/^(file|http:\/\/localhost)/.test(n)))
  expect(remote).toEqual([])
  await shot(win, '03-fonts')
})
```

Селекторы `assistant-text` и `.md-code` — сверить с текущими `RibbonItem.tsx` / `Markdown.tsx` и при необходимости взять существующие `data-testid`.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/tokens.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts -g "проза"`
Expected: FAIL — пакетов нет, есть `@font-face`, проза моноширинная (`body` сейчас `--font-mono`).

- [ ] **Step 3: Зависимости и подключение**

`npm install --save-exact @fontsource-variable/inter@5.3.0 @fontsource-variable/geist-mono@5.3.0`; перед этим `npm view @fontsource-variable/inter@5.3.0 version` и то же для geist-mono — должны вернуть `5.3.0` (если часы ПК отстают и TLS ругается «certificate is not yet valid», TLS не отключать — сказать владельцу). В `main.tsx` — `import '@fontsource-variable/inter'` и `import '@fontsource-variable/geist-mono'` до `tokens.css`; открыть их `index.css` в `node_modules` и убедиться, что имена семейств — `Inter Variable` и `Geist Mono Variable`, а подмножество `cyrillic` присутствует. Удалить `@font-face` и `GeistMono.woff2`. Добавить `allowScripts` не нужно (у пакетов нет скриптов установки — проверить `npm view … scripts`).

- [ ] **Step 4: Моноширинный только там, где код**

Пройти `grep -rn "font-family" src/renderer --include=*.css`: `--font-mono` остаётся только у кода, путей, команд, вывода, сочетаний клавиш, имён команд в списке `/`. Всё прочее (заголовки, подписи, кнопки, проза, пустая вкладка, строка статуса кроме чисел-путей) — `--font-ui` по наследству от `body` (лишние объявления удалить). Таймеры, проценты, счётчики — `font-variant-numeric: tabular-nums`.

- [ ] **Step 5: Прогнать — проходит**

Run: `npx vitest run tests/unit/tokens.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add package.json package-lock.json src/renderer tests/unit/tokens.test.ts tests/e2e/look.spec.ts
git rm src/renderer/assets/fonts/GeistMono.woff2
git commit -m "style: Inter for prose, Geist Mono only for code, bundled from packages"
```

---

### Task 4: Шкала шрифта в компонентах и обычный регистр заголовков

**Files:**
- Create: `tests/unit/styleRules.test.ts`
- Modify: все `src/renderer/**/*.css` с `font-size`/`line-height`/`text-transform`/`letter-spacing`; `tokens.css` (убрать алиасы старых размеров)

**Interfaces:**
- Consumes: `rendererCssFiles()`, `stripComments()` из Task 1; шкала `--text-*`, `--leading*`, `--weight-*`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/styleRules.test.ts
const files = rendererCssFiles().map((f) => [f, stripComments(readFileSync(f, 'utf8'))] as const)
const hits = (re: RegExp) => files.flatMap(([f, src]) => [...src.matchAll(re)].map((m) => `${f}: ${m[0]}`))

test('размер шрифта — только ступени шкалы', () => {
  expect(hits(/font-size:\s*(?!var\(--text-(xs|sm|md|lg|xl|2xl)\))[^;]+/g)).toEqual([])
})
test('межстрочный — только токены', () => {
  expect(hits(/line-height:\s*(?!var\(--leading)(?!1;)[^;]+/g)).toEqual([])
})
test('никакого капса', () => {
  expect(hits(/text-transform:\s*uppercase/g)).toEqual([])
})
test('вес — только токены', () => {
  expect(hits(/font-weight:\s*(?!var\(--weight-)[^;]+/g)).toEqual([])
})
```

(`line-height: 1` для значков допустим — исключение в регулярном выражении.)

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/styleRules.test.ts`
Expected: FAIL — десятки px-размеров (10.5, 11.5, 12.5, 17, 19, 22 …), пять `uppercase`.

- [ ] **Step 3: Заменить**

Сопоставление размеров — таблица «Шкала» в «Решениях по виду». Проза ленты (ответ агента, сообщение пользователя) — `--text-lg` / `--leading-prose`, `max-width: var(--prose-max-w)`, выравнивание влево. Заголовки разделов панели, приложения, ленты и Markdown (`h6`/подписи таблиц) — без `uppercase` и `letter-spacing`, `--weight-strong`, цвет `--text-dim`. Алиасы старых размеров из Task 1 удалить из `tokens.css`.

- [ ] **Step 4: Прогнать — проходит, e2e не сломаны**

Run: `npx vitest run && npm run test:e2e`
Expected: PASS (тексты в e2e проверяются без учёта регистра CSS — `uppercase` на `textContent` не влияет; если какой-то тест сверял `toHaveText` с капсом из CSS — его нет, но проверить падения).

- [ ] **Step 5: Снимки и коммит**

`QCLOD_SHOT_DIR=… npx playwright test tests/e2e/look.spec.ts` — снимок `04-type` (лента с ответом, панель открыта; добавить `await shot(win, '04-type')` в тест про шрифты после открытия панели).

```bash
git add src/renderer tests/unit/styleRules.test.ts tests/e2e/look.spec.ts
git commit -m "style: one type scale everywhere, headings in sentence case"
```

---

### Task 5: Цвета только из токенов, без неона

**Files:**
- Modify: все CSS компонентов с hex/`rgba`/`--glow*`/градиентами (по скану на 2026-11-10: `Composer.css`, `HistoryScreen.css`, `Ribbon.css`, `SetupScreen.css`, `TitleBar.css`, `Markdown.css`, `SidePanel.css`, `ActionPalette.css`, `InlineMenu.css`, `SettingsScreen.css`, `Paths.css`, `NowLine.css`, `ChatPane.css` — пересканировать), `tokens.css` (удалить алиасы)
- Test: `tests/unit/styleRules.test.ts`, `tests/unit/tokens.test.ts`

**Interfaces:**
- Consumes: токены Task 1; `--content-max-w`, `--content-gutter`.

- [ ] **Step 1: Падающие тесты**

```ts
// styleRules.test.ts
test('в CSS компонентов нет цветовых литералов', () => {
  expect(hits(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b(?![-\w])/g)).toEqual([])
})
test('нет свечения и декоративных градиентов', () => {
  expect(hits(/--glow|linear-gradient|radial-gradient|backdrop-filter/g)).toEqual([])
})
test('в TSX нет инлайн-цветов', () => {
  const tsx = rendererTsxFiles().flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/g)].map((m) => `${f}: ${m[0]}`))
  expect(tsx).toEqual([])
})
test('ширина колонки чата — один токен (NowLine и предупреждение о закрытии)', () => {
  const chat = readFileSync(resolve(root, 'src/renderer/components/ChatPane.css'), 'utf8')
  expect(chat).not.toMatch(/920px/)
  expect(chat).toContain('var(--content-max-w)')
})

// tokens.test.ts
test('старых токенов стекла больше нет', () => {
  for (const n of ['--glow', '--glow-accent', '--glow-soft', '--menu-blur', '--surface-sunken', '--now-max-w', '--now-gutter', '--ok', '--warn', '--danger']) {
    expect(t.has(n)).toBe(false)
  }
})
```

`--seg-buffer` (`repeating-linear-gradient`) живёт в `tokens.css` и не попадает под запрет — это текстура dataviz, а не украшение.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/styleRules.test.ts tests/unit/tokens.test.ts`
Expected: FAIL — ~15 литералов, `--glow*` в 9 файлах, `920px` в `ChatPane.css`.

- [ ] **Step 3: Заменить**

- `#0c0f1c` (текст на акценте) → `var(--on-accent)`; `!important` в `SetupScreen.css` убрать, если не нужен.
- Подсветка кода `.tok-*` в `Markdown.css` → `--syn-*`; инлайн-код с `--glow` → `color: var(--text); background: var(--surface-hover)`.
- Метка в заголовке → сплошной `var(--accent)`, без тени; индикатор работы вкладки (`TitleBar.css`, `--glow` с тенью) → `var(--accent)` без тени; активная вкладка — `background: var(--surface)` и 2px полоса `var(--accent)` сверху вместо `inset`-тени с `rgba`.
- `--glow-accent` на полях/кнопках → кольцо фокуса (Task 6 его закрепит): `box-shadow: var(--focus-ring)` только на `:focus-within`/`:focus-visible`, не постоянно.
- Тени модальных окон → `var(--shadow-modal)`, меню → `var(--shadow-menu)`; затемнение → `var(--backdrop)`.
- Фиолетовые акценты в панели (`SidePanel.css`, `--glow`) — это агенты → `var(--cat-agent)`; в ленте (`Ribbon.css`, тонировка `--glow` 7%) — сообщение пользователя → `color-mix(in srgb, var(--accent) 8%, var(--surface-raised))`.
- `--surface-sunken` → `--bg`; `--ok/--warn/--danger` → `--status-*`; `--danger-fill`/`--warn-fill`/`--accent-fill*`/`--hover-fill` переписать в `tokens.css` через `color-mix(in srgb, var(--…) N%, var(--surface-raised))` (непрозрачные) вместо `rgba`.
- `ChatPane.css`: `width: min(var(--content-max-w), calc(100% - 2 * var(--content-gutter)))`; `NowLine.css` — те же токены.
- Удалить алиасы из Task 1.

- [ ] **Step 4: Прогнать — проходит**

Run: `npx vitest run && npm run typecheck && npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Снимки и коммит**

Снимки `05-chat` (лента с карточками всех категорий из сценария `tests/e2e/ribbon.spec.ts`), `05-menu` (список `/`). Добавить в `look.spec.ts` тест-снимок без утверждений о цвете (их держат юнит-тесты).

```bash
git add src/renderer tests/unit tests/e2e/look.spec.ts
git commit -m "style: colours only from tokens, no glow or gradients"
```

---

### Task 6: Кольцо фокуса видно везде

**Files:**
- Modify: `tokens.css` (глобальные правила фокуса), CSS с `outline: none` (по скану: `ActionPalette.css`, `Composer.css`, `HistoryScreen.css`, `Ribbon.css` ×2, `SettingsScreen.css` ×2, `Paths.css` — пересканировать); при необходимости `App.tsx`/модальные окна — возврат фокуса
- Test: `tests/unit/styleRules.test.ts`, `tests/e2e/look.spec.ts`

**Interfaces:**
- Produces: в `tokens.css`
  ```css
  :focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring-color); outline-offset: var(--focus-offset); }
  ```
  Поле, у которого кольцо рисует контейнер, помечается классом `.ring-on-parent` (`outline: none` ровно в одном месте — в `tokens.css`: `.ring-on-parent:focus-visible { outline: none }`), а контейнер — `.ring-host:focus-within { box-shadow: var(--focus-ring) }`.
- Produces (e2e): `expectFocusRing(win: Page): Promise<void>` в `tests/e2e/helpers/launch.ts` — у `document.activeElement` либо `outline-style != none` и ширина ≥ 2px, либо ближайший предок `.ring-host` имеет `box-shadow`, содержащий цвет акцента `rgb(90, 139, 255)`.

- [ ] **Step 1: Падающие тесты**

```ts
// styleRules.test.ts
test('outline не гасится в компонентах', () => {
  expect(hits(/outline:\s*(none|0)\b/g)).toEqual([])
})
```

```ts
// look.spec.ts
for (const where of ['главный экран', 'настройки', 'история', 'палитра']) {
  test(`Tab по «${where}» — у каждого фокуса видно кольцо`, async () => {
    const { app, win } = await launchQclod({ env: { QCLOD_FAKE_HISTORY: JSON.stringify({ sessions: [/* 2 сессии как в history.spec.ts */] }) } })
    // открыть экран: Ctrl+, / кнопка истории / Ctrl+K
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      await win.keyboard.press('Tab')
      const id = await win.evaluate(() => { const a = document.activeElement as HTMLElement
        return a === document.body ? 'body' : a.outerHTML.slice(0, 80) })
      expect(id).not.toBe('body')
      if (seen.has(id)) break
      seen.add(id)
      await expectFocusRing(win)
    }
    expect(seen.size).toBeGreaterThan(3)
    await shot(win, `06-focus-${where}`)
    await app.close()
  })
}

test('Esc закрывает настройки и возвращает фокус на кнопку настроек', async () => {
  // Tab до кнопки настроек, Enter, Esc
  await expect(win.locator('[data-testid="open-settings"]')).toBeFocused()
  await expectFocusRing(win)
})

test('при масштабе 80% кольцо фокуса не пропадает', async () => {
  await win.keyboard.press('Control+-'); await win.keyboard.press('Control+-')
  await win.keyboard.press('Tab')
  await expectFocusRing(win)
})
```

`data-testid` кнопки настроек — сверить с `TitleBar.tsx`. Если в главном экране Tab застревает в поле ввода (Tab там может вставлять отступ) — начинать обход с заголовка: клик по пустому месту заголовка, затем Tab.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/styleRules.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts -g "фокус|Tab|Esc"`
Expected: FAIL — 8 `outline: none`; у кнопок заголовка и строк меню нет кольца; после Esc фокус на `body`.

- [ ] **Step 3: Реализация**

Глобальное правило и классы — в `tokens.css`. Поля ввода (поле сообщения, поиск истории, поле палитры, поля настроек) — `.ring-on-parent`, их рамки — `.ring-host`. Строки списков с `aria-activedescendant` (`InlineMenu`, `Dropdown`, палитра) — выбранная строка подсвечивается `--surface-hover` и 2px полосой акцента слева, это и есть их фокус; сам список — `.ring-host`. Модальные окна (`SettingsScreen`, `HistoryScreen`, `ActionPalette`) при закрытии возвращают фокус элементу, который был активен при открытии (запомнить `document.activeElement` в эффекте открытия). Убедиться, что ловушка фокуса в модальном окне есть (Tab не уходит за лист) — если нет, добавить в той же задаче.

- [ ] **Step 4: Прогнать — проходит**

Run: та же команда + `npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests/unit/styleRules.test.ts tests/e2e
git commit -m "fix: visible focus ring on every control, focus returns after Esc"
```

---

### Task 7: Текст выделяется везде, кроме хрома окна

**Files:**
- Modify: `tokens.css` (`body`), CSS с `user-select` (`Ribbon.css`, `SubagentCard.css`, `tool/Tool.css`, `Composer.css`, `SettingsScreen.css`), `TitleBar.css`
- Test: `tests/unit/styleRules.test.ts`, `tests/e2e/look.spec.ts`

**Interfaces:**
- Produces: в `tokens.css` нет `user-select` у `body`; `user-select: none` разрешён только у: `.title-bar` (и всего внутри), `button`, `[role="tab"]`, шапки свёрнутой карточки инструмента и подагента (клик по ней раскрывает), ручки разделителя панелей. Список — константа `CHROME_SELECTORS` в тесте.

- [ ] **Step 1: Падающие тесты**

```ts
// styleRules.test.ts — разбор правил: селектор { … user-select: none … }
test('user-select: none только у хрома', () => {
  const offenders = cssRules().filter((r) => /user-select:\s*none/.test(r.body) && !CHROME_SELECTORS.some((s) => r.selector.includes(s)))
  expect(offenders.map((r) => `${r.file}: ${r.selector}`)).toEqual([])
})
```

(`cssRules(): Array<{ file: string; selector: string; body: string }>` — добавить в `cssTokens.ts`, простой разбор `селектор { тело }` без вложенности, вместе с `tokens.css`.)

```ts
// look.spec.ts — сценарий: ответ агента + карточка Bash с выводом (из ribbon.spec.ts), панель открыта
test('двойной клик выделяет слово в ленте, выводе и панели, но не в заголовке', async () => {
  const selected = async (sel: string) => { await win.locator(sel).first().dblclick()
    return win.evaluate(() => document.getSelection()?.toString() ?? '') }
  expect(await selected('[data-testid="assistant-text"]')).not.toBe('')
  // раскрыть карточку команды
  expect(await selected('[data-testid="tool-output"]')).not.toBe('')
  expect(await selected('[data-testid="panel-context"]')).not.toBe('')
  expect(await selected('[data-testid="tab"]')).toBe('')
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/styleRules.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts -g "двойной клик"`
Expected: FAIL — `body { user-select: none }`, панель не выделяется.

- [ ] **Step 3: Реализация**

Снять `user-select` с `body`; добавить `.title-bar, button, [role="tab"] { user-select: none }`; лишние `user-select: text` удалить (теперь это поведение по умолчанию). `-webkit-app-region: drag` заголовка не трогать.

- [ ] **Step 4: Прогнать — проходит**

Run: та же + `npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests/unit tests/e2e/look.spec.ts
git commit -m "fix: text is selectable everywhere except window chrome"
```

---

### Task 8: Lucide везде, кнопки окна одного размера, уровни — разными значками

**Files:**
- Modify: `src/renderer/ui/icons.tsx`, `TitleBar.tsx`, `SetupScreen.tsx`, `markdown/Markdown.tsx`, `Ribbon.css` (каретка `▍`), `SidePanel.tsx`, `StatusLine.tsx`, `ContextBanner.tsx`
- Test: `tests/unit/styleRules.test.ts`, `tests/e2e/look.spec.ts`

**Interfaces:**
- Produces (`icons.tsx`):
  - `export const CHROME_ICON_SIZE = 14`
  - `export const LEVEL_ICON: Record<'warn' | 'critical', LucideIcon> = { warn: TriangleAlert, critical: OctagonAlert }`
  - `LevelIcon({ level, label, size = 13 }: { level: ContextLevel; label: string; size?: number }): JSX.Element | null` — `null` при `ok`; иначе значок цвета `var(--status-<level>)`, `role="img"`, `aria-label={label}`, `data-level-icon={level}`.
- Consumes: `ContextLevel` из `src/renderer/chat/contextLevel.ts`.

Подписи (`label`): контекст — warn «Контекст заполняется», critical «Контекст почти заполнен»; лимиты — warn «Лимит близко», critical «Лимит почти исчерпан».

- [ ] **Step 1: Падающие тесты**

```ts
// styleRules.test.ts
const GLYPHS = /[\u2190-\u21FF\u2500-\u25FF\u2600-\u27BF\u2B00-\u2BFF\u{1F300}-\u{1FAFF}]/u
test('нет Unicode-глифов вместо значков', () => {
  const found = [...rendererTsxFiles(), ...rendererCssFiles()].flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').map((line, i) => [f, i + 1, line] as const)
      .filter(([, , line]) => !/^\s*(\/\/|\*|\/\*)/.test(line) && GLYPHS.test(line)))
  expect(found.map(([f, n]) => `${f}:${n}`)).toEqual([])
})
```

```ts
// look.spec.ts
test('значки кнопок окна одного размера', async () => {
  const sizes = await win.locator('[data-testid="title-bar"] .window-controls svg').evaluateAll((s) => s.map((x) => x.getAttribute('width')))
  expect(new Set(sizes).size).toBe(1)
})

test('80% и 92% — разные значки уровня в панели и строке статуса', async () => {
  // сценарий и шаги — как в statusline.spec.ts «80% — индикатор меняет уровень…»
  await expect(win.locator('[data-testid="panel-context"] [data-level-icon="warn"]')).toHaveClass(/lucide-triangle-alert/)
  // дальше до 92%
  await expect(win.locator('[data-testid="panel-context"] [data-level-icon="critical"]')).toHaveClass(/lucide-octagon-alert/)
  await expect(win.locator('[data-testid="status-context"] [data-level-icon="critical"]')).toHaveAttribute('aria-label', 'Контекст почти заполнен')
  await shot(win, '08-levels')
})
```

Класс контейнера кнопок окна (`.window-controls`) — сверить с `TitleBar.tsx`, при отсутствии обернуть три кнопки. Тест `status-meter-alert` в `statusline.spec.ts` обновить на `data-level-icon`, если он опирается на старый значок.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/styleRules.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts -g "значки|разные значки"`
Expected: FAIL — `✓`/`•` в `SetupScreen.tsx`, `✓` в `Markdown.tsx`, `▍` в `Ribbon.css`; размеры 15/12/16; везде `CircleAlert`.

- [ ] **Step 3: Реализация**

`SetupScreen`: найдено — `CircleCheck` цвета `--status-ok`, не найдено — `Circle` цвета `--text-faint`, оба с `aria-label`. `Markdown`: отмеченный пункт списка — `Check` в квадрате рамки `--border-strong`. Каретка потока в `Ribbon.css` — псевдоэлемент шириной 2px, высотой `1em`, `background: var(--accent)`, мигание уважает `prefers-reduced-motion`. `TitleBar`: все значки управления — `CHROME_ICON_SIZE`; у `Square` добавить `absoluteStrokeWidth`, чтобы квадрат не выглядел мельче. `SidePanel`, `StatusLine` (контекст и оба лимита), `ContextBanner` — `LevelIcon` вместо `CircleAlert`.

- [ ] **Step 4: Прогнать — проходит**

Run: `npx vitest run && npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests/unit tests/e2e
git commit -m "style: Lucide instead of glyphs, even window buttons, distinct warn and critical icons"
```

---

### Task 9: Загрузка, пусто и ошибка у каждого экрана

**Files:**
- Create: `src/renderer/ui/StateView.tsx`, `src/renderer/ui/StateView.css`, `src/main/testSeams/ipcFaults.ts`, `tests/unit/ipcFaults.test.ts`, `tests/e2e/states.spec.ts`
- Modify: `src/main/agentIpc.ts` (`historyList`, `agentRibbon`), `src/main/ipc.ts` (`settingsGet`), `src/main/index.ts` (`hotkeyStatus`), `App.tsx`, `HistoryScreen.tsx`, `SettingsScreen.tsx`, `SetupScreen.tsx`, `EmptyTab.tsx`, `SidePanel.tsx`, `ActionPalette.tsx`, `scripts/check-release-seams.mjs`, `tests/fixtures/fake-sdk/README.md`

**Interfaces:**
- Produces:
  - `StateView({ kind, title, hint, action, testId }: { kind: 'loading' | 'empty' | 'error'; title: string; hint?: string; action?: { label: string; onClick: () => void }; testId?: string }): JSX.Element` — значок (`LoaderCircle` с вращением, уважающим `prefers-reduced-motion` / `Inbox` / `CircleAlert` цвета `--status-critical`), заголовок `--text`, подсказка `--text-dim`, кнопка. `role="status"` для loading/empty, `role="alert"` для error. `data-state={kind}`.
  - `withFault<T>(channel: string, run: () => T | Promise<T>): Promise<T>` в `ipcFaults.ts`: под `__QCLOD_TEST_SEAMS__` читает `QCLOD_FAKE_SLOW` (JSON `{ [channel]: ms }`) и `QCLOD_FAKE_FAIL` (JSON `{ [channel]: message }`) — ждёт и/или бросает `new Error(message)`; без шва — просто `run()`.

Состояния (тексты — точные):

| Экран | Загрузка | Пусто | Ошибка |
|---|---|---|---|
| История | «Читаю историю…» | (есть) ; при поиске без совпадений — «Ничего не нашлось по «{запрос}»» | «Не удалось прочитать историю» + причина в подсказке + «Повторить» |
| Настройки | лист открывается сразу: «Загружаю настройки…» (сейчас без `settings` не открывается вовсе) | правил нет — (есть) | хоткей/правила не прочитались — строка-ошибка в своём разделе с «Повторить»; сохранение упало — «Не сохранилось: {причина}» на месте «Сохранено» |
| Вкладка (лента) | открытие прошлого разговора: «Загружаю разговор…» | `EmptyTab` | `ribbon()` отклонён — «Не удалось загрузить разговор» + «Повторить» (хвост Task 18 этапа 2: сейчас `EmptyTab` скрыт навсегда) |
| Установка | «Проверить» нажато — «Проверяю…», кнопка неактивна | — | установка не удалась — последние строки журнала видны + «Не получилось установить. Повторить» |
| Панель | данных ещё нет — «Появится после первого ответа» | агентов нет — «Агентов нет» | — |
| Палитра Ctrl+K | — | «Ничего не нашлось» | — |

Перед реализацией перечитать каждый экран: что из таблицы уже есть — оставить текст как есть и перевести на `StateView`.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/unit/ipcFaults.test.ts
test('без шва просто выполняет', async () => expect(await withFault('history:list', () => 1)).toBe(1))
test('QCLOD_FAKE_FAIL бросает с текстом', async () => {
  process.env.QCLOD_FAKE_FAIL = JSON.stringify({ 'history:list': 'нет доступа' })
  await expect(withFault('history:list', () => 1)).rejects.toThrow('нет доступа')
})
test('QCLOD_FAKE_SLOW ждёт', async () => {
  process.env.QCLOD_FAKE_SLOW = JSON.stringify({ 'settings:get': 50 })
  const t0 = Date.now(); await withFault('settings:get', () => 1)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
})
```

```ts
// tests/e2e/states.spec.ts
test('история: загрузка, затем ошибка и «Повторить»', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_FAKE_SLOW: '{"history:list":1500}', QCLOD_FAKE_FAIL: '{"history:list":"нет доступа"}' } })
  // открыть историю
  await expect(win.locator('[data-testid="history-screen"] [data-state="loading"]')).toContainText('Читаю историю…')
  await shot(win, '09-history-loading')
  const err = win.locator('[data-testid="history-screen"] [data-state="error"]')
  await expect(err).toContainText('Не удалось прочитать историю')
  await expect(err).toContainText('нет доступа')
  await shot(win, '09-history-error')
  await app.close()
})
test('история: поиск без совпадений', async () => { /* сессии из QCLOD_FAKE_HISTORY, запрос «zzz» */
  await expect(win.locator('[data-state="empty"]')).toContainText('Ничего не нашлось по «zzz»') })
test('настройки открываются сразу и показывают загрузку', async () => { /* QCLOD_FAKE_SLOW settings:get 1500 */ })
test('лента не загрузилась — ошибка и «Повторить» вместо пустоты', async () => { /* QCLOD_FAKE_FAIL agent:ribbon */
  await expect(win.locator('[data-state="error"]')).toContainText('Не удалось загрузить разговор') })
test('панель без данных — «Появится после первого ответа»', async () => {})
```

Имена каналов — из `src/shared/channels.ts` (`history:list`, `settings:get`, `hotkey:status`, ленты — сверить). Шов `agent:ribbon` нельзя заваливать навсегда — «Повторить» тоже упадёт; для проверки повтора добавить в `withFault` счётчик: `QCLOD_FAKE_FAIL_TIMES` (JSON `{ [channel]: n }`, по умолчанию бесконечно) — отказывать первые n раз.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/ipcFaults.test.ts && npm run build:e2e && npx playwright test tests/e2e/states.spec.ts`
Expected: FAIL — модуля нет, состояний нет.

- [ ] **Step 3: Шов и `StateView`**

`withFault` обернуть вокруг обработчиков четырёх каналов. Новые переменные — в `check-release-seams.mjs` и `README.md` фейка.

- [ ] **Step 4: Экраны по таблице**

`App.tsx`: `listHistory` и `ribbon` получают `.catch` с состоянием ошибки (никаких необработанных отказов); «Повторить» повторяет тот же вызов. `SettingsScreen` открывается без `settings` и сам показывает загрузку.

- [ ] **Step 5: Прогнать — проходит**

Run: `npx vitest run && npm run test:e2e`
Expected: PASS, в выводе vitest нет «Unhandled Rejection».

- [ ] **Step 6: Коммит**

```bash
git add src tests scripts/check-release-seams.mjs
git commit -m "feat: loading, empty and error states on every screen"
```

---

### Task 10: Настройки, история, палитра и установка — в одной системе; контраст каждого экрана

**Files:**
- Create: `src/renderer/ui/controls.css`, `tests/e2e/helpers/contrast.ts`, `tests/e2e/screens.spec.ts`
- Modify: `main.tsx` (импорт `controls.css`), `SettingsScreen.tsx/.css`, `HistoryScreen.tsx/.css`, `ActionPalette.tsx/.css`, `SetupScreen.tsx/.css`, `EmptyTab.css`, `PermissionCard.tsx`, `QuestionCard.tsx`, `PlanCard.tsx` (кнопки)

**Interfaces:**
- Produces (`controls.css`): `.btn` (рамка `--border-strong`, фон `--surface-raised`), `.btn-primary` (фон `--accent`, текст `--on-accent`), `.btn-danger` (текст и рамка `--status-critical`), `.btn-ghost` (без рамки, наведение `--surface-hover`), `.btn-sm`; `.field` (+ `.ring-host`), `.field-label`, `.field-hint`; `.sheet-backdrop`, `.sheet` (`--surface-raised`, `--radius-lg`, `--shadow-modal`), `.sheet-head`, `.sheet-title` (`--text-xl`, `--weight-strong`), `.sheet-body` (прокрутка), `.sheet-foot`.
- Produces (`contrast.ts`): `auditContrast(win: Page, root?: string): Promise<Array<{ text: string; ratio: number; color: string; background: string; selector: string }>>` — нарушители. Алгоритм: для каждого видимого элемента с собственным непустым текстовым узлом (не `aria-hidden`, не `disabled`, не `[inert]`, `opacity` не 0) взять `color` и пройти вверх по предкам, смешивая `background-color` с альфой (поддержать `rgb()`, `rgba()` и `color(srgb r g b / a)`, в который Chromium сериализует `color-mix`) до непрозрачного; нет непрозрачного — фон `body`. Порог 4.5:1, для текста ≥ 24px или ≥ 18.66px при весе ≥ 600 — 3:1.

- [ ] **Step 1: Падающие тесты**

```ts
// tests/e2e/screens.spec.ts
const SCREENS: Array<{ name: string; open: (win: Page) => Promise<void>; env?: Record<string, string>; script?: unknown }> = [
  { name: 'пустая вкладка', open: async () => {} },
  { name: 'лента', script: /* все категории + раскрытая команда и правка — из ribbon.spec.ts */, open: /* отправить */ },
  { name: 'настройки', open: (w) => w.keyboard.press('Control+,') },
  { name: 'история', env: { QCLOD_FAKE_HISTORY: /* 3 сессии */ }, open: /* кнопка истории */ },
  { name: 'палитра', open: (w) => w.keyboard.press('Control+k') },
  { name: 'установка', env: /* как в setup.spec.ts — агент не найден */, open: async () => {} },
  { name: 'разрешение', script: /* как в permissions.spec.ts */, open: /* отправить */ },
  { name: 'панель 92%', script: /* как в statusline.spec.ts */, open: /* до 92%, открыть панель */ }
]
for (const s of SCREENS) {
  test(`контраст текста ≥ 4.5:1 — ${s.name}`, async () => {
    const { app, win } = await launchQclod({ env: s.env, script: s.script })
    await s.open(win)
    expect(await auditContrast(win)).toEqual([])
    await shot(win, `10-${s.name}`)
    await app.close()
  })
}

test('модальные окна — один лист', async () => {
  for (const open of [/* настройки, история, палитра */]) {
    await open(win)
    await expect(win.locator('.sheet')).toHaveCount(1)
    await win.keyboard.press('Escape')
  }
})
```

- [ ] **Step 2: Прогнать — падает**

Run: `npm run build:e2e && npx playwright test tests/e2e/screens.spec.ts`
Expected: FAIL — `.sheet` нет; аудит находит что-то (ожидаемо: даты на пустой вкладке — хвост Task 18 этапа 2, подписи кнопок на тонировках). Если аудит ничего не находит ни на одном экране — проверить сам помощник: временно подставить в тест элемент `color: #333` и убедиться, что он ловится.

- [ ] **Step 3: Общие стили и перевод экранов**

Четыре экрана переводятся на `.sheet*`, `.btn*`, `.field*`; их собственные CSS-файлы сжимаются до особенностей экрана (список истории, журнал установки, строки палитры). Экран установки — не модальный, но та же анатомия по центру `--bg`. Даты и вторичный текст пустой вкладки — `--text-dim` (не `--text-faint`). Каждое найденное аудитом нарушение чинится сменой токена, а не порога.

- [ ] **Step 4: Прогнать — проходит**

Run: `npm run test:e2e && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer tests/e2e
git commit -m "style: settings, history, palette and setup share one sheet; every screen passes contrast"
```

---

### Task 11: Лента, строка статуса и индикаторы на новом фоне (dataviz)

Компоненты этапа 2 перекрашены токенами, но рассчитаны на старый тёмно-синий фон. Здесь — подгонка материала и правила индикаторов.

**Files:**
- Modify: `tool/Tool.css`, `SubagentCard.css`, `NowLine.css`, `TodoStrip.css`, `StatusLine.tsx/.css`, `SidePanel.css`, `Ribbon.css`, и CSS компонентов этапа 2, появившихся после 2026-11-10 (очередь, фоновые задачи)
- Test: `tests/e2e/look.spec.ts`, `tests/unit/tokens.test.ts`

**Interfaces:**
- Consumes: `LevelIcon` (Task 8), токены Task 1.
- Produces: `--tool-chip-tint` пересчитан под новые поверхности (стартовое значение 14%; итог — по аудиту контраста Task 10 и снимку), индикатор `.meter` с `data-level`.

- [ ] **Step 1: Падающие тесты**

```ts
// look.spec.ts — сценарий statusline.spec.ts
test('индикатор: обычный уровень без статусного цвета, подпись текстовым токеном, концы скруглены', async () => {
  const fill = win.locator('[data-testid="status-context"] .meter-fill')
  const label = win.locator('[data-testid="status-context"] .meter-label')
  // при 42%
  expect(await fill.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(161, 161, 171)') // --text-dim
  expect(await label.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(161, 161, 171)')
  expect(await label.evaluate((e) => getComputedStyle(e).fontVariantNumeric)).toContain('tabular-nums')
  const r = await fill.evaluate((e) => [getComputedStyle(e).borderRadius, e.getBoundingClientRect().height])
  expect(parseFloat(r[0] as string)).toBeCloseTo((r[1] as number) / 2, 0)
  // при 92%: заливка --status-critical, подпись всё так же --text-dim
  expect(await fill.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 99, 105)')
  expect(await label.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(161, 161, 171)')
})
```

```ts
// tokens.test.ts
test('чип категории: значок читается на своей тонировке', () => {
  // смешать --cat-X с --surface-raised на --tool-chip-tint (sRGB), проверить contrast(--cat-X, смесь) ≥ 3
})
```

(функция `mix(a: string, b: string, pct: number): string` — добавить в `cssTokens.ts`.)

Классы `.meter-fill`/`.meter-label` — сверить со `StatusLine.tsx`; если индикатор устроен иначе, переименовать там.

- [ ] **Step 2: Прогнать — падает**

Run: `npx vitest run tests/unit/tokens.test.ts && npm run build:e2e && npx playwright test tests/e2e/look.spec.ts -g "индикатор"`
Expected: FAIL — обычная заливка сейчас `--status-ok` или подпись цветом уровня (сверить), чип 18% на светлых значках может не дать 3:1.

- [ ] **Step 3: Реализация**

Правила dataviz из «Решений по виду»: статусный цвет — только при `warn/critical` и только на заливке и значке; подпись — `--text-dim`, `tabular-nums`. Карточки ленты — `--surface-raised` с рамкой `--border`, полоска категории 2px; наведение на шапку — `--surface-hover`. `NowLine` — фон `--surface`, верхняя граница `--border`. Сообщение пользователя — тонировка акцента 8% (Task 5). Плотность — значения, выбранные в playground (Task 1).

- [ ] **Step 4: Прогнать — проходит, аудит контраста зелёный**

Run: `npx vitest run && npm run test:e2e`
Expected: PASS (включая `screens.spec.ts`).

- [ ] **Step 5: Снимки и коммит**

Снимки `11-ribbon`, `11-subagent`, `11-status-42`, `11-status-92`, `11-panel`.

```bash
git add src/renderer tests
git commit -m "style: ribbon, status line and meters tuned for the graphite theme"
```

---

### Task 12: Общий прогон и снимки всех экранов для владельца

**Files:**
- Modify: `tests/e2e/screens.spec.ts` (блок снимков, только по `QCLOD_SHOT=1`), `tests/e2e/screenshot.spec.ts` (удалить — его заменяет новый блок)

- [ ] **Step 1: Падающий тест на маленькое окно**

```ts
test('800×600 — нет горизонтальной прокрутки, кнопки строки статуса и заголовка видны целиком', async () => {
  const { app, win } = await launchQclod({ size: { width: 800, height: 600 } })
  expect(await win.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  for (const sel of ['[data-testid="title-bar"] button', '[data-testid="status-line"] button']) {
    for (const b of await win.locator(sel).all()) {
      const box = await b.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= 800).toBe(true)
    }
  }
  await shot(win, '12-min-size')
  await app.close()
})
```

Run: `npm run build:e2e && npx playwright test tests/e2e/screens.spec.ts -g "800"` — если проходит сразу, оставить как защиту (это не новая функция, а проверка) и записать в ledger; если падает — поправить токены отступов/переносы в строке статуса.

- [ ] **Step 2: Блок снимков**

`test.describe('снимки для владельца')` под `test.skip(process.env.QCLOD_SHOT !== '1')`, окно 1180×760, каждый снимок — `shot(win, 'final-NN-имя')`:
01 пустая вкладка; 02 лента со всеми категориями; 03 раскрытая команда; 04 раскрытая правка с диффом; 05 подагент с лентой шагов; 06 строка «сейчас» с открытым списком агентов; 07 полоска задач раскрыта; 08 список `/`; 09 второй шаг `/model`; 10 меню пути; 11 строка статуса 82%; 12 плашка 92% и панель с разбивкой; 13 карточка разрешения с фокусом на главной кнопке; 14 вопрос агента; 15 палитра Ctrl+K; 16 настройки; 17 настройки, правила разрешений; 18 история со списком; 19 история — загрузка; 20 история — ошибка; 21 лента не загрузилась; 22 экран установки — агент не найден; 23 установка идёт (журнал); 24 очередь сообщений; 25 фоновые задачи; 26 Tab-обход заголовка (кольцо фокуса); 27 минимальный размер 800×600.
Сценарии — из соответствующих spec-файлов этапа 2 (`ribbon`, `chat`, `commands`, `paths`, `statusline`, `panel`, `permissions`, `planmode`, `settings`, `history`, `setup`, `input`, `composer`) — импортировать их сценарии, если они вынесены, иначе скопировать.

- [ ] **Step 3: Всё зелёное**

Run: `npm run typecheck && npm run test:unit && npm run test:e2e`
Expected: 0 ошибок типов, всё PASS, нет «Unhandled Rejection».

- [ ] **Step 4: Статические проверки руками**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" src/renderer --include=*.css | grep -v styles/tokens.css` и `grep -rn "outline: none" src/renderer | grep -v tokens.css`
Expected: пусто (их держат тесты; это контроль, что тесты смотрят на все файлы).

- [ ] **Step 5: Снять**

Run: `QCLOD_SHOT=1 QCLOD_SHOT_DIR="C:\Users\user\AppData\Local\Temp\claude\b4ba85a236a252e7\b03a667e-aa34-4cdf-b322-bcee1b3ea39e\scratchpad\stage3" npm run build:e2e && npx playwright test tests/e2e/screens.spec.ts -g "снимки"`
Expected: 27 файлов `final-*.png`. Открыть каждый и посмотреть на перекрытия, обрезки, слипшиеся подписи; найденное — чинить до показа.

- [ ] **Step 6: Коммит**

```bash
git add tests/e2e
git rm tests/e2e/screenshot.spec.ts
git commit -m "test: screen shots and min-size check for the new look"
```

- [ ] **Step 7: Показать и ждать**

Отдать владельцу папку снимков и короткий список: что изменилось (графит вместо стекла, Inter, один акцент, фокус, выделение, состояния), что решено без него (кобальтовый акцент, Inter вместо Geist Sans, светлая лаванда агента, зелёный/янтарный различаются значком, а не цветом, для дальтоников). Этап принят только после его оценки в работающем приложении; к этапу 4 по виду не переходить до неё.
