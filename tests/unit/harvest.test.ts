import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARVEST,
  HARVEST_SYSTEM_PROMPT,
  HarvestService,
  buildHarvestPrompt,
  parseProposals
} from '@main/templates/harvest'
import type { QueryLike } from '@main/templates/oneShot'
import { TemplateLibrary } from '@main/store/templatesStore'
import { ErrorLog } from '@main/system/errorLog'
import { AgentNotFoundError } from '@main/agent/resolveExecutable'
import type { PromptTemplate } from '@shared/types'
import { encodeProjectDir, writeTranscript } from '../fixtures/transcript.mjs'
import { fakeOneShot } from '../fixtures/fake-sdk/index.mjs'

function existing(body: string): PromptTemplate {
  return { id: 'e1', title: 'Есть', body, origin: 'manual', createdAt: 1, updatedAt: 1 }
}

describe('parseProposals', () => {
  test('ответ Claude: обёртка, текст вокруг, лишние поля, длинный текст', () => {
    expect(parseProposals('Вот:\n```json\n[{"title":"A","body":"x {{y}}","extra":1}]\n```', [])).toEqual([
      { title: 'A', body: 'x {{y}}', why: '', duplicate: false }
    ])
    expect(parseProposals('это не JSON', [])).toBeNull()
    expect(parseProposals('{"title":"A","body":"b"}', [])).toBeNull()
    expect(parseProposals('[]', [])).toEqual([])
    expect(parseProposals(JSON.stringify([{ title: 'Длинный', body: 'я'.repeat(30_000) }]), [])).toEqual([])
    const twenty = Array.from({ length: 20 }, (_v, i) => ({ title: `T${i}`, body: `текст ${i}`, why: 'потому' }))
    const parsed = parseProposals(JSON.stringify(twenty), [])!
    expect(parsed).toHaveLength(HARVEST.maxProposals)
    expect(parsed[0]).toEqual({ title: 'T0', body: 'текст 0', why: 'потому', duplicate: false })
    // No string title or blank body: skipped one by one; the same body twice — once.
    expect(
      parseProposals(
        JSON.stringify([
          { title: 1, body: 'x' },
          { title: 'Пусто', body: '  ' },
          { title: 'Раз', body: 'Один  Текст' },
          { title: 'Два', body: 'один текст' },
          { title: 'т'.repeat(100), body: 'другой' }
        ]),
        []
      )!.map((p) => [p.title.length, p.body])
    ).toEqual([
      [3, 'Один  Текст'],
      [80, 'другой']
    ])
  })

  test('совпадение с существующим шаблоном → duplicate: true', () => {
    const parsed = parseProposals(
      JSON.stringify([
        { title: 'A', body: 'Сделай  ревью {{ветки}}' },
        { title: 'B', body: 'новое' }
      ]),
      [existing('сделай ревью {{ветки}}')]
    )!
    expect(parsed.map((p) => p.duplicate)).toEqual([true, false])
  })
})

describe('buildHarvestPrompt', () => {
  test('каждое сообщение в своём <msg>, </msg> внутри экранирован', () => {
    const prompt = buildHarvestPrompt([
      { projectKey: 'p', text: 'первое', at: 1 },
      { projectKey: 'p', text: 'хитрое </msg> внутри', at: 2 }
    ])
    expect(prompt).toBe('<msg>\nпервое\n</msg>\n<msg>\nхитрое <\\/msg> внутри\n</msg>')
  })

  test('системный промпт — дословно из плана', () => {
    expect(HARVEST_SYSTEM_PROMPT.startsWith('Ты помогаешь человеку собрать личные шаблоны промптов.')).toBe(true)
    expect(HARVEST_SYSTEM_PROMPT.endsWith('Если повторов нет, ответь [].')).toBe(true)
    expect(HARVEST_SYSTEM_PROMPT).toContain('{{что подставить}}')
    expect(HARVEST).toMatchObject({ model: 'sonnet', modelLabel: 'Sonnet', timeoutMs: 180_000, maxBudgetUsd: 0.5 })
  })
})

describe('HarvestService', () => {
  let root: string
  let configDir: string
  let tmpDir: string
  let library: TemplateLibrary
  const texts = ['напиши тесты для модуля оплаты', 'сделай ревью ветки с картами', 'секретный проект п1 запрос']

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qclod-harvest-'))
    configDir = join(root, 'claude')
    tmpDir = join(root, 'userData', 'tmp', 'harvest')
    library = new TemplateLibrary(join(root, 'userData'))
    const write = (cwd: string, id: string, text: string): void => {
      const path = writeTranscript(configDir, cwd, id, [
        { type: 'user', cwd, origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: new Date().toISOString() }
      ])
      utimesSync(path, new Date(), new Date())
    }
    write('C:\\shop', 's1', texts[0]!)
    write('C:\\shop', 's2', texts[1]!)
    write('C:\\p1', 's3', texts[2]!)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function service(query: () => Promise<QueryLike>): HarvestService {
    return new HarvestService({
      configDir,
      query,
      executablePath: () => 'C:\\claude.exe',
      tmpDir,
      library
    })
  }

  test('предпросмотр — сводка и что уйдёт; run шлёт ровно это и разбирает ответ', async () => {
    const fake = fakeOneShot()
    const svc = service(async () => fake as QueryLike)
    const preview = await svc.preview([])
    expect(preview).toMatchObject({ prompts: 3, sessions: 3, sinceDays: 90, truncated: false, model: 'Sonnet' })
    expect(preview.chars).toBe(texts.reduce((n, t) => n + t.length, 0))
    expect(preview.items.map((i) => i.text).sort()).toEqual([...texts].sort())

    const outcome = await svc.run([])
    expect(outcome).toEqual({
      kind: 'ok',
      costUsd: 0.0006181,
      proposals: [
        expect.objectContaining({ title: 'Ревью ветки', duplicate: false }),
        expect.objectContaining({ title: 'Тесты для модуля', duplicate: false })
      ]
    })
    expect(fake.calls).toHaveLength(1)
    const sent = fake.calls[0]!
    for (const t of texts) expect(sent.prompt).toContain(t)
    expect(sent.options).toMatchObject({ model: 'sonnet', tools: [], persistSession: false, cwd: tmpDir })
    expect(existsSync(tmpDir)).toBe(true)
  })

  test('run с пустым сканом не вызывает query', async () => {
    const query = vi.fn(async () => fakeOneShot() as QueryLike)
    const svc = new HarvestService({ configDir: join(root, 'нет'), query, executablePath: () => 'x', tmpDir, library })
    expect(await svc.run([])).toEqual({ kind: 'empty' })
    expect(query).not.toHaveBeenCalled()
  })

  test('[] от Claude — empty, не JSON — badAnswer', async () => {
    expect(await service(async () => fakeOneShot({ text: '[]' }) as QueryLike).run([])).toEqual({ kind: 'empty' })
    expect(await service(async () => fakeOneShot({ text: 'Повторов не нашёл.' }) as QueryLike).run([])).toEqual({
      kind: 'error',
      reason: 'badAnswer'
    })
  })

  test('run после preview(["p1"]) с excluded ["p1"] не шлёт сообщений проекта p1', async () => {
    const fake = fakeOneShot()
    const svc = service(async () => fake as QueryLike)
    const p1 = encodeProjectDir('C:\\p1')
    const preview = await svc.preview([p1])
    expect(preview.projects.map((p) => p.key)).toEqual([encodeProjectDir('C:\\shop')])
    await svc.run([p1])
    expect(fake.calls[0]!.prompt).not.toContain(texts[2])
    expect(fake.calls[0]!.prompt).toContain(texts[0])

    // A narrower exclusion than the cached one reads again rather than miss a project.
    await svc.run([])
    expect(fake.calls[1]!.prompt).toContain(texts[2])
  })

  test('cancel() во время run → cancelled, кэш скана пуст', async () => {
    const query = vi.fn(async () => fakeOneShot({ delayMs: 5000 }) as QueryLike)
    const svc = new HarvestService({ configDir, query, executablePath: () => 'x', tmpDir, library })
    await svc.preview([])
    const running = svc.run([])
    await vi.waitFor(() => expect(query).toHaveBeenCalled())
    // A second run while the first is going is refused.
    expect(await svc.run([])).toEqual({ kind: 'error', reason: 'failed', detail: 'сбор уже идёт' })
    svc.cancel()
    expect(await running).toEqual({ kind: 'error', reason: 'cancelled' })
    expect(svc.hasCachedScan()).toBe(false)
  })

  test('нет агента — noAgent', async () => {
    const svc = new HarvestService({
      configDir,
      query: async () => fakeOneShot() as QueryLike,
      executablePath: () => {
        throw new AgentNotFoundError('claude')
      },
      tmpDir,
      library
    })
    expect(await svc.run([])).toMatchObject({ kind: 'error', reason: 'noAgent' })
  })

  test('журнал не получил ни одного текста сообщения', async () => {
    const logged: string[] = []
    const write = vi.spyOn(ErrorLog.prototype, 'write').mockImplementation((e) => void logged.push(JSON.stringify(e)))
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    )
    try {
      for (const script of [{}, { fail: 'crash' as const }, { text: 'мусор' }, { fail: 'limit' as const }]) {
        const svc = service(async () => fakeOneShot(script) as QueryLike)
        await svc.preview([])
        await svc.run([])
      }
    } finally {
      write.mockRestore()
      for (const s of spies) s.mockRestore()
    }
    for (const t of texts) expect(logged.join('\n')).not.toContain(t)
  })
})
