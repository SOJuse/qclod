import { describe, expect, test } from 'vitest'
import { configHosts } from '@main/ssh/sshConfig'

const none = (): string[] => []

describe('configHosts', () => {
  test('I10: имена с метасимволами оболочки и ведущим - не берутся', () => {
    expect(configHosts('Host ok -oProxyCommand=x a;b c$d e|f good.lan\n', none)).toEqual(['ok', 'good.lan'])
  })

  test('Host a b *.x !c даёт a, b', () => {
    expect(configHosts('Host a b *.x !c\n  HostName 1.2.3.4\n', none)).toEqual(['a', 'b'])
  })

  test('регистр host не важен, повторы и шаблоны отброшены, порядок сохранён', () => {
    const text = ['host web', 'HOST db', 'Host web', 'Host=gw', 'Host * ', 'Host ?x', 'Host "quoted"'].join('\n')
    expect(configHosts(text, none)).toEqual(['web', 'db', 'gw', 'quoted'])
  })

  test('комментарии и Match пропущены', () => {
    const text = ['# Host commented', 'Match host foo exec "true"', '  User x', 'Host real # tail', ''].join('\n')
    expect(configHosts(text, none)).toEqual(['real'])
  })

  test('Include config.d/* читает включённое', () => {
    const asked: string[] = []
    const read = (pattern: string): string[] => {
      asked.push(pattern)
      return pattern === 'config.d/*' ? ['Host inc1\n', 'Host inc2 a\n'] : []
    }
    expect(configHosts('Host a\nInclude config.d/*\nHost z\n', read)).toEqual(['a', 'inc1', 'inc2', 'z'])
    expect(asked).toEqual(['config.d/*'])
  })

  test('Include рекурсивно, не глубже 5 уровней', () => {
    let calls = 0
    const read = (): string[] => {
      calls++
      return [`Host h${calls}\nInclude loop\n`]
    }
    const hosts = configHosts('Include loop\n', read)
    expect(calls).toBe(5)
    expect(hosts).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
  })
})
