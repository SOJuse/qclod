import { describe, expect, test } from 'vitest'
import { cudaReady, detectNvidia, parseNvidiaSmi, type ExecFileLike } from '@main/voice/nvidia'

describe('parseNvidiaSmi', () => {
  test('одна карта', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3090, 616.92, 24576')).toEqual({
      name: 'NVIDIA GeForce RTX 3090',
      driver: '616.92',
      memoryMb: 24576
    })
  })

  test('из двух строк выбирается большая память', () => {
    const csv = 'NVIDIA GeForce GTX 1050, 616.92, 2048\r\nNVIDIA GeForce RTX 4070, 616.92, 12282\r\n'
    expect(parseNvidiaSmi(csv)?.name).toBe('NVIDIA GeForce RTX 4070')
  })

  test('мусор → null', () => {
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toBeNull()
    expect(parseNvidiaSmi('RTX, abc, 100')).toBeNull()
    expect(parseNvidiaSmi('RTX, 616.92, [N/A]')).toBeNull()
  })
})

describe('cudaReady', () => {
  test('нет карты', () => {
    expect(cudaReady(null)).toEqual({ ok: false, reason: 'Нужна видеокарта NVIDIA' })
  })
  test('старый драйвер', () => {
    expect(cudaReady({ name: 'RTX 3090', driver: '537.13', memoryMb: 24576 })).toEqual({
      ok: false,
      reason: 'Нужен драйвер NVIDIA 551.61 или новее (сейчас 537.13)'
    })
    expect(cudaReady({ name: 'RTX 3090', driver: '551.52', memoryMb: 24576 }).ok).toBe(false)
    expect(cudaReady({ name: 'RTX 3090', driver: '551.61', memoryMb: 24576 }).ok).toBe(true)
  })
  test('мало видеопамяти', () => {
    expect(cudaReady({ name: 'GTX 1050', driver: '616.92', memoryMb: 2048 })).toEqual({
      ok: false,
      reason: 'Нужно не меньше 4 ГБ видеопамяти'
    })
  })
  test('3090 — ok', () => {
    expect(cudaReady({ name: 'NVIDIA GeForce RTX 3090', driver: '616.92', memoryMb: 24576 })).toEqual({ ok: true })
  })
})

describe('detectNvidia', () => {
  test('запрос к nvidia-smi из System32, аргументы и таймаут 5 с', async () => {
    const calls: Array<{ file: string; args: string[]; timeout: number }> = []
    const run: ExecFileLike = async (file, args, opts) => {
      calls.push({ file, args, timeout: opts.timeout })
      return { stdout: 'NVIDIA GeForce RTX 3090, 616.92, 24576\r\n' }
    }
    expect(await detectNvidia(run, 'win32')).toEqual({
      name: 'NVIDIA GeForce RTX 3090',
      driver: '616.92',
      memoryMb: 24576
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file.toLowerCase()).toMatch(/system32\\nvidia-smi\.exe$/)
    expect(calls[0].args).toEqual([
      '--query-gpu=name,driver_version,memory.total',
      '--format=csv,noheader,nounits'
    ])
    expect(calls[0].timeout).toBe(5000)
  })

  test('ENOENT в System32 — запасной путь NVSMI; ENOENT везде — null', async () => {
    const tried: string[] = []
    const enoent: ExecFileLike = async (file) => {
      tried.push(file)
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    expect(await detectNvidia(enoent, 'win32')).toBeNull()
    expect(tried).toHaveLength(2)
    expect(tried[1]).toBe('C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
  })

  test('таймаут — null', async () => {
    const hang: ExecFileLike = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    }
    expect(await detectNvidia(hang, 'win32')).toBeNull()
  })

  test('не Windows — null, nvidia-smi не спрашивается', async () => {
    let asked = false
    const run: ExecFileLike = async () => {
      asked = true
      return { stdout: '' }
    }
    expect(await detectNvidia(run, 'linux')).toBeNull()
    expect(asked).toBe(false)
  })

  test('QCLOD_FAKE_NVIDIA: none — null, иначе строка CSV', async () => {
    const run: ExecFileLike = async () => {
      throw new Error('must not run')
    }
    const old = process.env['QCLOD_FAKE_NVIDIA']
    try {
      process.env['QCLOD_FAKE_NVIDIA'] = 'none'
      expect(await detectNvidia(run, 'win32')).toBeNull()
      process.env['QCLOD_FAKE_NVIDIA'] = 'NVIDIA GeForce RTX 2060, 560.10, 6144'
      expect(await detectNvidia(run, 'win32')).toEqual({
        name: 'NVIDIA GeForce RTX 2060',
        driver: '560.10',
        memoryMb: 6144
      })
    } finally {
      if (old === undefined) delete process.env['QCLOD_FAKE_NVIDIA']
      else process.env['QCLOD_FAKE_NVIDIA'] = old
    }
  })
})
