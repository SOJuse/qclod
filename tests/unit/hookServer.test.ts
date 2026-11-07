import { afterEach, describe, expect, test } from 'vitest'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { startHookServer, type HookServer } from '@main/sessions/hookServer'
import type { HookEvent } from '@shared/types'

let server: HookServer | undefined

function pipePath(): string {
  return `\\\\.\\pipe\\qclod-test-${randomUUID()}`
}

function sendRaw(path: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      socket.end(payload, () => resolve())
    })
    socket.on('error', reject)
  })
}

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (check()) {
        clearInterval(tick)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick)
        reject(new Error('timed out'))
      }
    }, 20)
  })
}

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('hookServer', () => {
  test('корректное событие доходит до onEvent', async () => {
    const seen: HookEvent[] = []
    const path = pipePath()
    server = await startHookServer(path, (event) => seen.push(event))

    await sendRaw(path, JSON.stringify({ tabId: 't1', hook_event_name: 'Stop' }))
    await waitFor(() => seen.length === 1)

    expect(seen[0].tabId).toBe('t1')
    expect(seen[0].hook_event_name).toBe('Stop')
  })

  test('неразобранный JSON игнорируется и сервер жив', async () => {
    const seen: HookEvent[] = []
    const path = pipePath()
    server = await startHookServer(path, (event) => seen.push(event))

    await sendRaw(path, 'это совсем не json')
    await sendRaw(path, JSON.stringify({ tabId: 't1', hook_event_name: 'Stop' }))
    await waitFor(() => seen.length === 1)

    expect(seen).toHaveLength(1)
    expect(seen[0].tabId).toBe('t1')
  })

  test('событие без имени и без вкладки отбрасывается', async () => {
    const seen: HookEvent[] = []
    const path = pipePath()
    server = await startHookServer(path, (event) => seen.push(event))

    await sendRaw(path, JSON.stringify({ nothing: 'useful' }))
    await sendRaw(path, JSON.stringify({ tabId: 't2', hook_event_name: 'Stop' }))
    await waitFor(() => seen.length === 1)

    expect(seen).toHaveLength(1)
    expect(seen[0].tabId).toBe('t2')
  })

  test('событие, пришедшее частями, собирается целиком', async () => {
    const seen: HookEvent[] = []
    const path = pipePath()
    server = await startHookServer(path, (event) => seen.push(event))

    const payload = JSON.stringify({ tabId: 't3', hook_event_name: 'PermissionRequest' })
    await new Promise<void>((resolve, reject) => {
      const socket = connect(path, () => {
        socket.write(payload.slice(0, 10))
        setTimeout(() => socket.end(payload.slice(10), () => resolve()), 30)
      })
      socket.on('error', reject)
    })
    await waitFor(() => seen.length === 1)

    expect(seen[0].hook_event_name).toBe('PermissionRequest')
  })

  test('close освобождает канал', async () => {
    const path = pipePath()
    server = await startHookServer(path, () => undefined)
    await server.close()
    server = undefined

    // The pipe is gone, so connecting must fail rather than hang.
    await expect(sendRaw(path, '{}')).rejects.toBeTruthy()
  })
})
