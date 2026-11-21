import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

export interface NvidiaInfo {
  name: string
  driver: string
  memoryMb: number
}

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean }
) => Promise<{ stdout: string }>

const MIN_DRIVER = '551.61'
const MIN_MEMORY_MB = 4096
const QUERY = ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits']
const FALLBACK_SMI = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'

/** nvidia-smi's CSV, one card per line; the card with the most video memory. */
export function parseNvidiaSmi(csv: string): NvidiaInfo | null {
  let best: NvidiaInfo | null = null
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length !== 3) continue
    const [name, driver, memory] = parts
    if (name.length === 0 || !/^\d+(\.\d+)+$/.test(driver) || !/^\d+$/.test(memory)) continue
    const info = { name, driver, memoryMb: Number(memory) }
    if (best === null || info.memoryMb > best.memoryMb) best = info
  }
  return best
}

function olderThan(version: string, min: string): boolean {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/** Whether Whisper can run on this card (CUDA 12.4 needs driver 551.61). */
export function cudaReady(info: NvidiaInfo | null): { ok: true } | { ok: false; reason: string } {
  if (info === null) return { ok: false, reason: 'Нужна видеокарта NVIDIA' }
  if (olderThan(info.driver, MIN_DRIVER)) {
    return { ok: false, reason: `Нужен драйвер NVIDIA ${MIN_DRIVER} или новее (сейчас ${info.driver})` }
  }
  if (info.memoryMb < MIN_MEMORY_MB) return { ok: false, reason: 'Нужно не меньше 4 ГБ видеопамяти' }
  return { ok: true }
}

const execFileText: ExecFileLike = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout })
    })
  })

/** The NVIDIA card, from nvidia-smi; null without one, without the tool, or when it hangs. */
export async function detectNvidia(
  run: ExecFileLike = execFileText,
  platform: string = process.platform
): Promise<NvidiaInfo | null> {
  // e2e: 'none' or a line of nvidia-smi's CSV (buildFlags.d.ts).
  const fake = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_NVIDIA'] : undefined
  if (fake !== undefined && fake !== '') return fake === 'none' ? null : parseNvidiaSmi(fake)
  if (platform !== 'win32') return null
  const system32 = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe')
  for (const file of [system32, FALLBACK_SMI]) {
    try {
      const { stdout } = await run(file, QUERY, { timeout: 5000, windowsHide: true })
      return parseNvidiaSmi(stdout)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') continue
      return null
    }
  }
  return null
}
