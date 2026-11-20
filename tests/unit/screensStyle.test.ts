import { basename } from 'node:path'
import { expect, test } from 'vitest'
import { cssRules } from './cssTokens'

// The sheets (settings, palette), the setup screen, the empty tab and the shared controls.
// The history sheet is gone: past conversations live in the sidebar (stage 2, decision 4).
const SCREENS = [
  'controls.css',
  'SettingsScreen.css',
  'CommandPalette.css',
  'SetupScreen.css',
  'EmptyTab.css'
]
const all = cssRules()
const rules = all.filter((r) => SCREENS.includes(basename(r.file)))
// Notices that live elsewhere and said their problem in a status colour.
const NOTICES: Record<string, string[]> = {
  'TitleBar.css': ['.hotkey-warning'],
  'Paths.css': ['.path-menu-error']
}

// A rule that colours an icon may wear a status or category colour; text never does.
const ICON = /(svg|\.lucide[\w-]*|-icon)(:[\w-]+(\([^)]*\))?)*$/

test('все файлы экранов на месте', () => {
  expect(new Set(rules.map((r) => basename(r.file)))).toEqual(new Set(SCREENS))
})

test('статусный и категорийный цвет на экранах — только у значков, не у текста', () => {
  const notices = all.filter((r) =>
    (NOTICES[basename(r.file)] ?? []).some((n) => r.selector === n || r.selector.startsWith(n + ':'))
  )
  const offenders = [...rules, ...notices]
    .filter((r) => /(^|[\s;])color:\s*var\(--(status|cat)-/.test(r.body) && !ICON.test(r.selector))
    .map((r) => `${basename(r.file)}: ${r.selector}`)
  expect(offenders).toEqual([])
})

test('модальные окна не рисуют лист и кнопки сами — это controls.css', () => {
  const own = rules
    .filter((r) => basename(r.file) !== 'controls.css')
    .filter((r) => /box-shadow:\s*var\(--shadow-modal\)|background:\s*var\(--backdrop\)/.test(r.body))
    .map((r) => `${basename(r.file)}: ${r.selector}`)
  expect(own).toEqual([])
})

// A section's own button is spaced by its own class; a bare `.btn` rule would also reach
// the delete cross of a permission rule and the «Повторить» of a notice.
test('экран настроек не задаёт отступ всем кнопкам подряд', () => {
  const broad = rules
    .filter((r) => basename(r.file) === 'SettingsScreen.css' && /\.btn$/.test(r.selector) && /margin/.test(r.body))
    .map((r) => r.selector)
  expect(broad.filter((s) => !s.startsWith('.settings-rules'))).toEqual([])
})
