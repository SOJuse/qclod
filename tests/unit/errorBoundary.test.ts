import { afterEach, describe, expect, test, vi } from 'vitest'
import { ErrorBoundary } from '../../src/renderer/ui/ErrorBoundary'

afterEach(() => vi.unstubAllGlobals())

describe('ErrorBoundary', () => {
  test('getDerivedStateFromError keeps the error', () => {
    const err = new Error('x')
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err })
  })

  test('the pane fallback says what broke and offers a reload', () => {
    const b = new ErrorBoundary({ scope: 'pane', children: null })
    b.state = { error: new Error('kaput') }
    const json = JSON.stringify(b.render())
    expect(json).toContain('В этой панели что-то сломалось')
    expect(json).toContain('Перезагрузить панель')
    expect(json).toContain('kaput')
  })

  test('the app fallback offers a window reload', () => {
    const b = new ErrorBoundary({ scope: 'app', children: null })
    b.state = { error: new Error('kaput') }
    const json = JSON.stringify(b.render())
    expect(json).toContain('Окно споткнулось')
    expect(json).toContain('Перезагрузить окно')
  })

  test('componentDidCatch reports with the boundary scope', () => {
    const reportError = vi.fn()
    vi.stubGlobal('window', { qclod: { reportError } })
    const b = new ErrorBoundary({ scope: 'pane', children: null })
    b.componentDidCatch(new Error('kaput'), { componentStack: '\n at Foo' })
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'pane', message: 'kaput', componentStack: '\n at Foo' })
    )
  })

  test('a failing report does not throw out of the boundary', () => {
    vi.stubGlobal('window', {
      qclod: {
        reportError: () => {
          throw new Error('no bridge')
        }
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = new ErrorBoundary({ scope: 'pane', children: null })
    expect(() => b.componentDidCatch(new Error('k'), { componentStack: '' })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
