import { describe, expect, test } from 'vitest'
import { projectKey, projectName } from '@shared/projects'

describe('projectKey', () => {
  test('один ключ для одной папки', () => {
    expect(projectKey('C:\\Proj')).toBe('c:\\proj')
    expect(projectKey('c:/proj/')).toBe('c:\\proj')
    expect(projectKey('C:\\Proj\\')).toBe('c:\\proj')
    expect(projectKey('C:\\')).toBe('c:\\')
    expect(projectKey('/home/u/p/')).toBe('/home/u/p')
  })

  test('сетевая папка — тот же ключ при любых разделителях и регистре', () => {
    expect(projectKey('\\\\Host\\Share\\Dir\\')).toBe('\\\\host\\share\\dir')
    expect(projectKey('//Host/Share/Dir')).toBe('\\\\host\\share\\dir')
  })

  test('папка на другом компьютере — ключ с его hostId впереди', () => {
    expect(projectKey('C:\\Proj\\', 'srv1')).toBe('srv1:c:\\proj')
    expect(projectKey('/home/u/p/', 'srv1')).toBe('srv1:/home/u/p')
    // The same path on two machines is two projects; locally nothing changes.
    expect(projectKey('/home/u/p', 'srv2')).not.toBe(projectKey('/home/u/p', 'srv1'))
    expect(projectKey('C:\\Proj', undefined)).toBe('c:\\proj')
    expect(projectKey('C:\\Proj', '')).toBe('c:\\proj')
  })

  test('корень и путь без разделителей не теряются', () => {
    expect(projectKey('C:/')).toBe('c:\\')
    expect(projectKey('C:')).toBe('c:\\')
    expect(projectKey('/')).toBe('/')
    expect(projectKey('/Home/U/')).toBe('/Home/U')
  })
})

describe('projectName', () => {
  test('последняя часть пути; корень диска — «C:»', () => {
    expect(projectName('C:\\dev\\qclod')).toBe('qclod')
    expect(projectName('C:\\')).toBe('C:')
  })

  test('хвостовой разделитель и прямые слэши не мешают', () => {
    expect(projectName('C:\\dev\\qclod\\')).toBe('qclod')
    expect(projectName('c:/dev/Qclod/')).toBe('Qclod')
    expect(projectName('/home/u/p/')).toBe('p')
    expect(projectName('\\\\host\\share')).toBe('share')
  })
})

describe('этап 6: проекты серверов', () => {
  test('одна папка на двух серверах и локально — три разных ключа', () => {
    const keys = new Set([projectKey('/home/u/app'), projectKey('/home/u/app', 'srv1'), projectKey('/home/u/app', 'srv2')])
    expect(keys.size).toBe(3)
  })

  test('buildSidebar с локальной и серверной вкладкой одной папки — два проекта, у серверного remote', async () => {
    const { buildSidebar } = await import('../../src/renderer/chat/sidebarModel')
    const tab = (id: string, server?: { hostId: string }) =>
      ({ id, cwd: '/home/u/app', title: 'app', overrides: {}, status: 'idle', badge: false, missingCwd: false, ...(server ? { server } : {}) }) as never
    const servers = [
      { id: 'srv1', label: 'Дом', target: 'me@home', auth: 'key', colour: 'violet', recent: [], fromConfig: false, state: 'online', hasPassword: false }
    ] as never
    const sidebar = buildSidebar([tab('a'), tab('b', { hostId: 'srv1' })], [], {}, servers)
    expect(sidebar).toHaveLength(2)
    const local = sidebar.find((p) => !p.remote)!
    const remote = sidebar.find((p) => p.remote)!
    expect(local.chats.map((c) => c.id)).toEqual(['a'])
    expect(remote.chats.map((c) => c.id)).toEqual(['b'])
    expect(remote.remote).toEqual({ hostId: 'srv1', label: 'Дом', color: 'violet' })
    expect(remote.key).toBe('srv1:/home/u/app')
  })
})
