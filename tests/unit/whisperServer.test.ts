import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import { dirname } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { encodeWav16 } from '@main/voice/wav'
import {
  isWhisperHallucination,
  WhisperServerEngine,
  type SpawnLike
} from '@main/voice/whisperServerEngine'

const EXE = 'C:\\Q\\models\\whisper\\Release\\whisper-server.exe'
const GGML = 'C:\\Q\\models\\whisper\\ggml-large-v3-turbo-q5_0.bin'
const CUDA_OK = [
  'ggml_cuda_init: GGML_CUDA_FORCE_MMQ:    no',
  'ggml_cuda_init: found 1 CUDA devices (Total VRAM: 24575 MiB):',
  '  Device 0: NVIDIA GeForce RTX 3090, compute capability 8.6, VMM: yes, VRAM: 24575 MiB'
]

interface FakeRun {
  spawn: SpawnLike
  calls: Array<{ file: string; args: string[]; opts: { cwd: string; windowsHide: boolean } }>
  bodies: string[]
  killed: () => boolean
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))))
})

function fake(o: { stderr: string[]; text?: string; listen?: boolean; hangAfter?: number }): FakeRun {
  const run: FakeRun = { spawn: undefined as unknown as SpawnLike, calls: [], bodies: [], killed: () => false }
  let killed = false
  run.killed = () => killed
  run.spawn = (file, args, opts) => {
    run.calls.push({ file, args, opts })
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (): boolean => {
        killed = true
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
        return true
      }
    })
    for (const line of o.stderr) child.stderr.write(line + '\n')
    if (o.listen !== false) {
      const port = Number(args[args.indexOf('--port') + 1])
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          if (req.method === 'POST' && req.url === '/inference') {
            run.bodies.push(Buffer.concat(chunks).toString('utf8'))
            // A hung driver: the request is taken and never answered.
            if (o.hangAfter !== undefined && run.bodies.length > o.hangAfter) return
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ text: o.text ?? '' }))
            return
          }
          res.writeHead(req.url === '/' ? 200 : 404)
          res.end('<html></html>')
        })
      })
      server.listen(port, '127.0.0.1')
      servers.push(server)
    }
    return child
  }
  return run
}

function engine(
  run: FakeRun,
  extra: { prompt?: string; readyTimeoutMs?: number; pids?: number[]; died?: string[]; decodeTimeoutMs?: number } = {}
): WhisperServerEngine {
  return new WhisperServerEngine({
    onDied: (why) => extra.died?.push(why),
    ...(extra.decodeTimeoutMs !== undefined ? { decodeTimeoutMs: extra.decodeTimeoutMs } : {}),
    exe: EXE,
    ggml: GGML,
    threads: 4,
    prompt: extra.prompt ?? 'Диктовка задачи для программиста. Claude, TypeScript',
    onPid: (pid) => extra.pids?.push(pid),
    spawn: run.spawn,
    readyTimeoutMs: extra.readyTimeoutMs ?? 5000
  })
}

describe('WhisperServerEngine', () => {
  test('аргументы и cwd сервера', async () => {
    const run = fake({ stderr: CUDA_OK })
    const pids: number[] = []
    const e = engine(run, { pids })
    await e.load()
    expect(e.model).toBe('whisper-turbo-cuda')
    expect(run.calls).toHaveLength(1)
    const { file, args, opts } = run.calls[0]
    expect(file).toBe(EXE)
    const port = args[args.indexOf('--port') + 1]
    expect(Number(port)).toBeGreaterThan(0)
    expect(args).toEqual(['-m', GGML, '-l', 'ru', '-t', '4', '--host', '127.0.0.1', '--port', port, '-nt'])
    // The exe's own folder, as this system's path module names it (Whisper runs on Windows only).
    expect(opts).toEqual({ cwd: dirname(EXE), windowsHide: true })
    expect(pids).toEqual([4321])
    await e.dispose()
    expect(run.killed()).toBe(true)
  })

  test('готов после строки CUDA и ответа 200', async () => {
    const run = fake({ stderr: CUDA_OK })
    const e = engine(run)
    await expect(e.load()).resolves.toBeUndefined()
    // прогрев: полсекунды тишины
    expect(run.bodies).toHaveLength(1)
    await e.dispose()
  })

  test('stderr без CUDA к готовности — gpu-failed, процесс убит', async () => {
    const run = fake({ stderr: ['whisper_init_with_params_no_state: use gpu = 1', 'whisper_backend_init: using CPU backend'] })
    await expect(engine(run).load()).rejects.toMatchObject({ code: 'gpu-failed' })
    expect(run.killed()).toBe(true)
  })

  test('«failed to initialize CUDA» в stderr — gpu-failed сразу', async () => {
    const run = fake({
      stderr: ['ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected'],
      listen: false
    })
    const started = Date.now()
    await expect(engine(run, { readyTimeoutMs: 20_000 }).load()).rejects.toMatchObject({ code: 'gpu-failed' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(run.killed()).toBe(true)
  })

  test('сервер не ответил за readyTimeoutMs — gpu-failed, процесс убит', async () => {
    const run = fake({ stderr: CUDA_OK, listen: false })
    await expect(engine(run, { readyTimeoutMs: 400 }).load()).rejects.toMatchObject({ code: 'gpu-failed' })
    expect(run.killed()).toBe(true)
  })

  test('сервер вышел до готовности — gpu-failed, код выхода в сообщении', async () => {
    const run = fake({ stderr: [], listen: false })
    const spawn = run.spawn
    run.spawn = (file, args, opts) => {
      const child = spawn(file, args, opts)
      setTimeout(() => (child as unknown as EventEmitter).emit('exit', 3221225781, null), 50)
      return child
    }
    await expect(engine(run, { readyTimeoutMs: 10_000 }).load()).rejects.toMatchObject({
      code: 'gpu-failed',
      message: expect.stringContaining('3221225781')
    })
  })

  test('I1-А: сервер упал после загрузки (CUDA OOM) — onDied с кодом выхода', async () => {
    let child!: EventEmitter
    const run = fake({ stderr: CUDA_OK })
    const spawn = run.spawn
    run.spawn = (file, args, opts) => {
      const c = spawn(file, args, opts)
      child = c as unknown as EventEmitter
      return c
    }
    const died: string[] = []
    const e = engine(run, { died })
    await e.load()
    expect(died).toEqual([])
    child.emit('exit', 3221226505, null)
    expect(died).toHaveLength(1)
    expect(died[0]).toContain('3221226505')
    await e.dispose()
    expect(died).toHaveLength(1)
  })

  test('I1-Б: сервер не отвечает на decode — таймаут, сервер убит, onDied', async () => {
    const run = fake({ stderr: CUDA_OK, hangAfter: 1 })
    const died: string[] = []
    const e = engine(run, { died, decodeTimeoutMs: 300 })
    await e.load()
    const started = Date.now()
    await expect(e.decode(new Float32Array(1600))).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(run.killed()).toBe(true)
    expect(died).toHaveLength(1)
    expect(died[0]).toMatch(/did not answer/)
  })

  test('таймаут decode растёт с длиной фразы: 3 × длина, не меньше заданного', async () => {
    const run = fake({ stderr: CUDA_OK, hangAfter: 1 })
    const died: string[] = []
    const e = engine(run, { died, decodeTimeoutMs: 100 })
    await e.load()
    const started = Date.now()
    // 0,25 с звука → 750 мс
    await expect(e.decode(new Float32Array(4000))).rejects.toThrow()
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(died).toHaveLength(1)
  })

  test('dispose не считается смертью сервера', async () => {
    const run = fake({ stderr: CUDA_OK })
    const died: string[] = []
    const e = engine(run, { died })
    await e.load()
    await e.dispose()
    await new Promise((r) => setTimeout(r, 10))
    expect(died).toEqual([])
  })

  test('decode шлёт файл WAV и поля language, response_format, prompt; возвращает trim', async () => {
    const run = fake({ stderr: CUDA_OK, text: '  Попроси Claude переписать на TypeScript.  ' })
    const e = engine(run, { prompt: 'Диктовка задачи для программиста. Claude' })
    await e.load()
    const text = await e.decode(new Float32Array(16000).fill(0.1))
    expect(text).toBe('Попроси Claude переписать на TypeScript.')
    const body = run.bodies[1]
    expect(body).toMatch(/name="file"; filename="[^"]+\.wav"/)
    expect(body).toContain('RIFF')
    expect(body).toContain('WAVE')
    expect(body).toMatch(/name="language"\r\n\r\nru\r\n/)
    expect(body).toMatch(/name="response_format"\r\n\r\njson\r\n/)
    expect(body).toMatch(/name="temperature"\r\n\r\n0\.0\r\n/)
    expect(body).toContain('name="prompt"\r\n\r\nДиктовка задачи для программиста. Claude\r\n')
    await e.dispose()
  })

  test('«Субтитры сделал DimaTorzok» на тишине — пустой текст', async () => {
    const run = fake({ stderr: CUDA_OK, text: ' Субтитры сделал DimaTorzok' })
    const e = engine(run)
    await e.load()
    expect(await e.decode(new Float32Array(8000))).toBe('')
    await e.dispose()
  })
})

test('isWhisperHallucination', () => {
  for (const t of [
    'Субтитры сделал DimaTorzok',
    'Субтитры создавал DimaTorzok',
    'Продолжение следует...',
    'Спасибо за просмотр!',
    'Редактор субтитров А.Синецкая',
    'DimaTorzok'
  ]) {
    expect(isWhisperHallucination(t)).toBe(true)
  }
  expect(isWhisperHallucination('Сделай субтитры к видео.')).toBe(false)
  expect(isWhisperHallucination('Запусти тесты.')).toBe(false)
})

test('encodeWav16: заголовок RIFF/WAVE, 16000 Гц, моно, 16 бит, 1,5 → 32767', () => {
  const b = encodeWav16(new Float32Array([0, 0.5, 1.5, -1.5, -1]))
  expect(b.length).toBe(44 + 10)
  expect(b.toString('ascii', 0, 4)).toBe('RIFF')
  expect(b.readUInt32LE(4)).toBe(36 + 10)
  expect(b.toString('ascii', 8, 12)).toBe('WAVE')
  expect(b.toString('ascii', 12, 16)).toBe('fmt ')
  expect(b.readUInt32LE(16)).toBe(16)
  expect(b.readUInt16LE(20)).toBe(1) // PCM
  expect(b.readUInt16LE(22)).toBe(1) // моно
  expect(b.readUInt32LE(24)).toBe(16000)
  expect(b.readUInt32LE(28)).toBe(32000)
  expect(b.readUInt16LE(32)).toBe(2)
  expect(b.readUInt16LE(34)).toBe(16)
  expect(b.toString('ascii', 36, 40)).toBe('data')
  expect(b.readUInt32LE(40)).toBe(10)
  expect(b.readInt16LE(44)).toBe(0)
  expect(b.readInt16LE(46)).toBe(16384)
  expect(b.readInt16LE(48)).toBe(32767)
  expect(b.readInt16LE(50)).toBe(-32767)
  expect(b.readInt16LE(52)).toBe(-32767)
  expect(encodeWav16(new Float32Array(1), 8000).readUInt32LE(24)).toBe(8000)
})
