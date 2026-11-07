import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, matchRule, saveRules, RULES_FILE } from '../../src/main/agent/permissionStore'

let dir = ''
let project = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-rules-'))
  project = mkdtempSync(join(tmpdir(), 'qclod-project-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('permissionStore', () => {
  test('правило по имени инструмента совпадает', () => {
    const rules = [{ id: 'r1', toolName: 'Read', behavior: 'allow' as const }]

    expect(matchRule(rules, 'Read', { file_path: 'C:/проект/любой.ts' })).toBe('allow')
    expect(matchRule(rules, 'Write', { file_path: 'C:/проект/любой.ts' })).toBeNull()
  })

  test('правило с путём совпадает только для него', () => {
    const rules = [
      { id: 'r1', toolName: 'Edit', target: 'C:/проект/auth.ts', behavior: 'allow' as const }
    ]

    expect(matchRule(rules, 'Edit', { file_path: 'C:/проект/auth.ts' })).toBe('allow')
    expect(matchRule(rules, 'Edit', { file_path: 'C:/проект/другой.ts' })).toBeNull()
  })

  test('правило-запрет сильнее правила-разрешения', () => {
    const rules = [
      { id: 'r1', toolName: 'Bash', behavior: 'allow' as const },
      { id: 'r2', toolName: 'Bash', target: 'rm -rf /', behavior: 'deny' as const }
    ]

    expect(matchRule(rules, 'Bash', { command: 'npm test' })).toBe('allow')
    expect(matchRule(rules, 'Bash', { command: 'rm -rf /' })).toBe('deny')
  })

  test('нет правила — null, решает человек', () => {
    expect(matchRule([], 'Bash', { command: 'npm test' })).toBeNull()
  })

  test('правила живут в хранилище Qclod, в проекте ничего не пишется', () => {
    saveRules(dir, [{ id: 'r1', toolName: 'Read', behavior: 'allow' }])

    expect(existsSync(join(dir, RULES_FILE))).toBe(true)
    // Constraint 5: the user's own settings files are never modified, and that
    // includes .claude/settings.local.json inside their repository.
    expect(readdirSync(project)).toEqual([])
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })

  test('сохранённые правила читаются обратно', () => {
    const rules = [
      { id: 'r1', toolName: 'Edit', target: 'C:/проект/auth.ts', behavior: 'allow' as const }
    ]
    saveRules(dir, rules)

    expect(loadRules(dir)).toEqual(rules)
  })

  test('повреждённый файл правил даёт пустой список, а не исключение', () => {
    writeFileSync(join(dir, RULES_FILE), '{это не json', 'utf8')
    expect(loadRules(dir)).toEqual([])

    writeFileSync(join(dir, RULES_FILE), '"строка"', 'utf8')
    expect(loadRules(dir)).toEqual([])

    writeFileSync(join(dir, RULES_FILE), '[1, null, {"toolName": 42}]', 'utf8')
    expect(loadRules(dir)).toEqual([])
  })

  test('отсутствующий файл правил — пустой список', () => {
    expect(loadRules(dir)).toEqual([])
  })
})
