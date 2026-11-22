import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitLayer, commitLabel, gitTitle, kindLabel } from '@renderer/components/git/GitLayer'
import { ChatHeader, gitButtonTitle } from '@renderer/components/ChatHeader'
import type { GitChange, GitStatus } from '@shared/types'

const ok = (changes: GitChange[], extra: Partial<Extract<GitStatus, { kind: 'ok' }>> = {}): GitStatus => ({
  kind: 'ok',
  branch: 'main',
  detachedAt: null,
  initial: false,
  changes,
  truncated: false,
  ...extra
})

const render = (status: GitStatus | null): string =>
  renderToStaticMarkup(
    createElement(GitLayer, {
      tabId: 't',
      source: { kind: 'local' },
      cwd: '/p',
      status,
      refresh: () => undefined,
      refreshNow: () => undefined
    })
  )

describe('заголовок слоя', () => {
  test('ветка, отдельный коммит, первый коммит', () => {
    expect(gitTitle(ok([]))).toBe('Изменения · main')
    expect(gitTitle(ok([], { branch: null, detachedAt: 'abc1234' }))).toBe('Изменения · отдельный коммит abc1234')
    expect(gitTitle(ok([], { initial: true }))).toBe('Изменения · первый коммит')
    expect(gitTitle(null)).toBe('Изменения')
  })
})

describe('метки', () => {
  test('по видам изменений', () => {
    const labels = (['modified', 'added', 'deleted', 'untracked', 'conflict', 'typechange'] as const).map((kind) =>
      kindLabel({ path: 'x', kind })
    )
    expect(labels).toEqual(['изменён', 'добавлен', 'удалён', 'новый', 'конфликт', 'тип изменён'])
    expect(kindLabel({ path: 'new.ts', oldPath: 'old.ts', kind: 'renamed' })).toBe('переименован из old.ts')
  })
})

describe('GitLayer', () => {
  test('все отмечены, кроме конфликта; кнопка коммита неактивна без сообщения', () => {
    const html = render(ok([
      { path: 'src/a.ts', kind: 'modified' },
      { path: 'b.ts', kind: 'untracked' },
      { path: 'c.ts', kind: 'conflict' }
    ]))
    const checks = [...html.matchAll(/<input[^>]*data-testid="git-file-check"[^>]*>/g)].map((m) => m[0])
    expect(checks).toHaveLength(3)
    expect(checks[0]).toContain('checked')
    expect(checks[1]).toContain('checked')
    expect(checks[2]).not.toContain('checked')
    expect(checks[2]).toContain('disabled')
    expect(html).toMatch(/data-testid="git-commit"[^>]*disabled/)
    expect(html).toContain('Есть конфликты слияния')
    expect(html).toContain('placeholder="Что сделано — сообщение коммита"')
    // The folder is dimmed, the name is not.
    expect(html).toContain('<span class="git-file-dir">src/</span>a.ts')
  })

  test('подпись «Закоммитить 3 файла»', () => {
    expect(commitLabel(3, false)).toBe('Закоммитить 3 файла')
    expect(commitLabel(1, false)).toBe('Закоммитить 1 файл')
    expect(commitLabel(5, false)).toBe('Закоммитить 5 файлов')
    expect(commitLabel(2, true)).toBe('Коммичу…')
    const html = render(ok([
      { path: 'a', kind: 'modified' },
      { path: 'b', kind: 'added' },
      { path: 'c', kind: 'deleted' }
    ]))
    expect(html).toContain('Закоммитить 3 файла')
  })

  test('truncated: «Показаны первые 2000 изменений.»', () => {
    expect(render(ok([{ path: 'a', kind: 'modified' }], { truncated: true }))).toContain('Показаны первые 2000 изменений.')
  })

  test('пусто, не репозиторий, нет Git, ошибка', () => {
    expect(render(ok([]))).toContain('Изменений нет — рабочая папка чистая.')
    expect(render({ kind: 'notRepo' })).toContain('Эта папка не под Git.')
    const noGit = render({ kind: 'noGit' })
    expect(noGit).toContain('Git не найден. Поставьте Git:')
    expect(noGit).toContain('https://git-scm.com/downloads')
    const err = render({ kind: 'error', message: 'сломалось' })
    expect(err).toContain('сломалось')
    expect(err).toContain('data-testid="git-refresh"')
  })
})

describe('кнопка «Git» в шапке', () => {
  const header = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(
      createElement(ChatHeader, {
        title: 'Чат',
        cwd: '/p/Чат',
        status: 'idle',
        split: false,
        panelShown: false,
        onTogglePanel: () => undefined,
        onOpenGit: () => undefined,
        ...props
      })
    )

  test('бейдж — число изменений, 0 не показывается', () => {
    expect(header({ gitBadge: 3 })).toContain('data-testid="git-badge">3<')
    expect(header({ gitBadge: 0 })).not.toContain('git-badge')
    expect(header({ gitBadge: null })).not.toContain('git-badge')
    expect(header({})).toContain('title="Изменения в папке проекта"')
  })

  test('неактивна без репозитория, без Git и когда недоступно', () => {
    expect(header({ gitState: 'notRepo' })).toMatch(/data-testid="git-open"[^>]*disabled/)
    expect(gitButtonTitle('notRepo')).toBe('Папка не под Git')
    expect(gitButtonTitle('noGit')).toBe('Git не найден')
    expect(gitButtonTitle('unavailable', 'Нужен Git 2.25 или новее.')).toBe('Нужен Git 2.25 или новее.')
    expect(header({ gitState: 'ok' })).not.toMatch(/data-testid="git-open"[^>]*disabled/)
  })
})
