import { describe, expect, test, vi } from 'vitest'
import { SessionHistory } from '../../src/main/agent/sessionHistory'

const sdkSessions = [
  {
    sessionId: '11111111-1111-1111-1111-111111111111',
    summary: 'Починка вставки файлов',
    lastModified: 1794083400000,
    firstPrompt: 'вставка файлов не работает'
  },
  {
    sessionId: '22222222-2222-2222-2222-222222222222',
    summary: '',
    lastModified: 1794000000000,
    customTitle: 'Переезд на SDK'
  }
]

function makeHistory(overrides: Partial<ConstructorParameters<typeof SessionHistory>[0]> = {}) {
  return new SessionHistory({
    listSessions: async () => sdkSessions,
    getSessionMessages: async () => [],
    ...overrides
  })
}

describe('SessionHistory', () => {
  test('список сессий папки переводится в понятные записи', async () => {
    const history = makeHistory()
    const list = await history.list('C:/проект')

    expect(list).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Починка вставки файлов',
        firstMessage: 'вставка файлов не работает',
        updatedAt: 1794083400000
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        title: 'Переезд на SDK',
        firstMessage: '',
        updatedAt: 1794000000000
      }
    ])
  })

  test('список спрашивается именно для этой папки', async () => {
    const listSessions = vi.fn(async () => [])
    await makeHistory({ listSessions }).list('C:/другой проект')

    expect(listSessions).toHaveBeenCalledWith({ dir: 'C:/другой проект' })
  })

  test('сессия без названия подписывается первым сообщением', async () => {
    const history = makeHistory({
      listSessions: async () => [
        { sessionId: 'id-3', summary: '', lastModified: 1, firstPrompt: 'сделай рефактор' }
      ]
    })

    expect((await history.list('C:/проект'))[0]!.title).toBe('сделай рефактор')
  })

  test('сессия совсем без подписи получает запасное название', async () => {
    const history = makeHistory({
      listSessions: async () => [{ sessionId: 'id-4', summary: '', lastModified: 1 }]
    })

    expect((await history.list('C:/проект'))[0]!.title).toBe('Без названия')
  })

  test('ошибка SDK даёт пустой список, а не падение', async () => {
    const history = makeHistory({
      listSessions: async () => {
        throw new Error('нет доступа к папке сессий')
      }
    })

    await expect(history.list('C:/проект')).resolves.toEqual([])
  })

  test('сообщения сессии отдаются как есть, для перевода в ленту', async () => {
    const messages = [{ type: 'user', message: { role: 'user', content: 'привет' } }]
    const history = makeHistory({ getSessionMessages: async () => messages })

    await expect(history.messages('id-1')).resolves.toEqual(messages)
  })

  test('нечитаемая сессия даёт пустую переписку, а не падение', async () => {
    const history = makeHistory({
      getSessionMessages: async () => {
        throw new Error('файл сессии повреждён')
      }
    })

    await expect(history.messages('id-1')).resolves.toEqual([])
  })
})
