import { describe, expect, test } from 'vitest'
import { parseStatusV2, MAX_CHANGES } from '@main/git/status'
import { parseUnifiedDiff, MAX_DIFF_LINES } from '@main/git/diff'
import { parseGitVersion } from '@main/git/gitRunner'

const H = 'a'.repeat(40)
const rec = (...fields: string[]): string => fields.join('\0') + '\0'
const entry1 = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`

describe('parseStatusV2', () => {
  test('изменённый, новый, удалённый, переименованный, конфликт', () => {
    const out = rec(
      '# branch.oid ' + H,
      '# branch.head main',
      entry1('.M', 'src/a.ts'),
      entry1('A.', 'src/new.ts'),
      entry1('.D', 'gone.ts'),
      entry1('.T', 'link'),
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 новый.ts`,
      'старый.ts',
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} clash.ts`,
      '? loose.txt',
      '! ignored.log'
    )
    const s = parseStatusV2(out)
    expect(s.branch).toBe('main')
    expect(s.detachedAt).toBeNull()
    expect(s.initial).toBe(false)
    expect(s.truncated).toBe(false)
    expect(s.changes).toEqual([
      { path: 'src/a.ts', kind: 'modified' },
      { path: 'src/new.ts', kind: 'added' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'link', kind: 'typechange' },
      { path: 'новый.ts', oldPath: 'старый.ts', kind: 'renamed' },
      { path: 'clash.ts', kind: 'conflict' },
      { path: 'loose.txt', kind: 'untracked' }
    ])
  })

  test('detached и initial', () => {
    const detached = parseStatusV2(rec('# branch.oid ' + H, '# branch.head (detached)'))
    expect(detached.branch).toBeNull()
    expect(detached.detachedAt).toBe('aaaaaaa')
    const initial = parseStatusV2(rec('# branch.oid (initial)', '# branch.head main', '? a.txt'))
    expect(initial.initial).toBe(true)
    expect(initial.branch).toBe('main')
    expect(initial.detachedAt).toBeNull()
  })

  test('путь с дефисом, скобками, кавычками и пробелами разобран без изменений', () => {
    const weird = "-rf [1] Привет 'x'.txt"
    const s = parseStatusV2(rec('# branch.head main', entry1('.M', weird), '? my dir/with space.md'))
    expect(s.changes.map((c) => c.path)).toEqual([weird, 'my dir/with space.md'])
  })

  test('2 001 запись → 2 000 и truncated', () => {
    const many = Array.from({ length: MAX_CHANGES + 1 }, (_, i) => `? f${i}.txt`)
    const s = parseStatusV2(rec('# branch.head main', ...many))
    expect(s.changes).toHaveLength(MAX_CHANGES)
    expect(s.truncated).toBe(true)
  })
})

describe('parseUnifiedDiff', () => {
  const header = 'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n'

  test('два куска, added/removed и пометка об оборванной строке', () => {
    const text =
      header +
      '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@ fn\n x\n+y\n+z\n\\ No newline at end of file\n'
    const d = parseUnifiedDiff(text)
    expect(d).toEqual({
      kind: 'text',
      added: 3,
      removed: 1,
      truncatedLines: 0,
      hunks: [
        { oldStart: 1, newStart: 1, lines: [' a', '-b', '+B', ' c'] },
        { oldStart: 10, newStart: 10, lines: [' x', '+y', '+z', '\\ No newline at end of file'] }
      ]
    })
  })

  test('двоичный файл', () => {
    expect(parseUnifiedDiff('Binary files a/x and b/x differ\n')).toEqual({ kind: 'binary' })
  })

  test('6 000 строк → 5 000 и truncatedLines 1000', () => {
    const body = Array.from({ length: 6000 }, (_, i) => `+l${i}`).join('\n')
    const d = parseUnifiedDiff(header + '@@ -0,0 +1,6000 @@\n' + body + '\n')
    if (d.kind !== 'text') throw new Error('text expected')
    expect(d.hunks[0]?.lines).toHaveLength(MAX_DIFF_LINES)
    expect(d.truncatedLines).toBe(1000)
    expect(d.added).toBe(6000)
  })
})

describe('parseGitVersion', () => {
  test('windows-сборка', () => {
    expect(parseGitVersion('git version 2.47.1.windows.1')).toEqual([2, 47])
    expect(parseGitVersion('nonsense')).toBeNull()
  })
})
