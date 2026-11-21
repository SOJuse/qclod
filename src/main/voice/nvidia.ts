import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/** Microsoft's own link to the x64 VC++ 2015–2022 Redistributable (I4, Ruling S5-R3). */
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
export const VC_REDIST_REASON =
  'Для Whisper нужен Microsoft Visual C++ Redistributable (x64). Установите его с сайта Microsoft и перезапустите Qclod.'
/** What whisper-server.exe, ggml.dll and ggml-cuda.dll import and the zip does not carry. */
const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] as const

/** Whether the Visual C++ runtime is in %SystemRoot%\System32 (where its installer puts the x64 DLLs). */
export function vcRuntimeReady(systemRoot: string, exists: (path: string) => boolean = existsSync): boolean {
  return VC_RUNTIME_DLLS.every((dll) => exists(win32.join(systemRoot, 'System32', dll)))
}

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
