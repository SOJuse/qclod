import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  BrowserWindow: class {}
}))

import { registerTemplatesIpc } from '@main/templatesIpc'
import { TemplateLibrary } from '@main/store/templatesStore'
import { sanitizeTemplateDraft } from '@main/tabs/sanitize'
import { CHANNELS } from '@shared/channels'
import type { PromptTemplate } from '@shared/types'

let dir: string
const sent: Array<[string, unknown]> = []

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(handlers.get(channel)!({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  sent.length = 0
  dir = mkdtempSync(join(tmpdir(), 'qclod-templates-ipc-'))
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) }
  }
  registerTemplatesIpc({
    library: new TemplateLibrary(dir),
    getWindow: () => win as unknown as Electron.BrowserWindow
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('templates IPC', () => {
  test('не-строка в templatesDelete → false', async () => {
    expect(await call(CHANNELS.templatesDelete, 42)).toBe(false)
    expect(await call(CHANNELS.templatesDelete, { id: 'x' })).toBe(false)
    expect(await call(CHANNELS.templatesDelete, 'нет-такого')).toBe(false)
  })

  test('templatesSave({ body: "" }) → null', async () => {
    expect(await call(CHANNELS.templatesSave, { body: '' })).toBeNull()
    expect(await call(CHANNELS.templatesSave, { title: 'x', body: '   ' })).toBeNull()
    expect(await call(CHANNELS.templatesSave, 'строка')).toBeNull()
    expect(sent).toEqual([])
  })

  test('templatesSaveMany с 60 записями сохраняет 50', async () => {
    const drafts = Array.from({ length: 60 }, (_v, i) => ({ title: `t${i}`, body: `b${i}`, origin: 'harvest' }))
    expect(await call(CHANNELS.templatesSaveMany, drafts)).toBe(50)
    expect(((await call(CHANNELS.templatesList)) as PromptTemplate[]).length).toBe(50)
    expect(await call(CHANNELS.templatesSaveMany, { 0: drafts[0] })).toBe(0)
    // A bad draft among good ones is skipped alone.
    expect(await call(CHANNELS.templatesSaveMany, [{ body: '' }, { title: 'ок', body: 'текст' }])).toBe(1)
  })

  test('после сохранения окно получило templates:changed со списком', async () => {
    const saved = (await call(CHANNELS.templatesSave, { title: 'Ревью', body: 'Проверь' })) as PromptTemplate
    expect(saved.title).toBe('Ревью')
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe('templates:changed')
    expect((sent[0]![1] as PromptTemplate[]).map((t) => t.id)).toEqual([saved.id])

    expect(await call(CHANNELS.templatesDelete, saved.id)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(['templates:changed', []])
  })
})

describe('sanitizeTemplateDraft', () => {
  test('поля проверяются и обрезаются по правилам', () => {
    expect(sanitizeTemplateDraft(null)).toBeNull()
    expect(sanitizeTemplateDraft({ body: 'x'.repeat(20_001) })).toBeNull()
    expect(sanitizeTemplateDraft({ title: 'x'.repeat(81), body: 'т' })).toBeNull()
    expect(sanitizeTemplateDraft({ id: '../x', body: 'т' })).toBeNull()
    expect(sanitizeTemplateDraft({ body: 'т', origin: 'чужой' })).toEqual({ title: 'т', body: 'т', origin: 'manual' })
    expect(sanitizeTemplateDraft({ id: 'a_B-1', title: '  Ревью ', body: '  текст \n', origin: 'harvest' })).toEqual({
      id: 'a_B-1',
      title: 'Ревью',
      body: 'текст',
      origin: 'harvest'
    })
    expect(sanitizeTemplateDraft({ body: '\n\nпервая\nвторая' })!.title).toBe('первая')
  })
})
