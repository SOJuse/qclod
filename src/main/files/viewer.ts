import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { ViewerContent } from '../../shared/types'

export const VIEWER_TEXT_MAX = 2 * 1024 * 1024
export const VIEWER_IMAGE_MAX = 10 * 1024 * 1024
/** A NUL in the first 8 KiB: not text. */
const SNIFF = 8 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** The highlighter's language (markdown/highlight.ts), by the file's extension. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.php': 'php',
  '.lua': 'lua',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.xml': 'xml',
  '.r': 'r',
  '.hs': 'haskell'
}

/** By signature first: an extension can lie, the first bytes rarely do. */
function imageType(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  // A known extension without its signature is not trusted as a picture.
  return null
}

export function isImagePath(path: string): boolean {
  return IMAGE_TYPES[extname(path).toLowerCase()] !== undefined
}

/** How much of the file the viewer wants: a whole picture, or the start of a text. */
export function viewerLimit(path: string): number {
  return isImagePath(path) ? VIEWER_IMAGE_MAX : VIEWER_TEXT_MAX
}

export function languageOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  if (/^makefile$/i.test(name)) return 'makefile'
  return LANGUAGES[extname(name).toLowerCase()] ?? ''
}

/**
 * What the viewer shows for a file of `size` bytes whose start is `head`. A
 * picture comes whole (≤ 10 MB); a NUL in the first 8 KiB is no text; a text
 * is cut at 2 MB, on a character, and says so.
 */
export function toViewerContent(path: string, head: Buffer, size: number): ViewerContent {
  const image = imageType(head)
  if (image) {
    if (size > VIEWER_IMAGE_MAX || head.length < size) return { kind: 'binary', size }
    return { kind: 'image', dataUrl: `data:${image};base64,${head.toString('base64')}`, size }
  }
  if (head.subarray(0, SNIFF).includes(0)) return { kind: 'binary', size }
  let body = head.subarray(0, VIEWER_TEXT_MAX)
  const truncated = size > VIEWER_TEXT_MAX || head.length > VIEWER_TEXT_MAX
  if (truncated) {
    // Back off a cut-through UTF-8 sequence: no broken character at the end.
    let end = body.length
    let back = 0
    while (back < 3 && end - back - 1 >= 0 && (body[end - back - 1]! & 0xc0) === 0x80) back++
    const lead = body[end - back - 1]
    if (lead !== undefined && lead >= 0xc0) {
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
      if (back + 1 < need) end = end - back - 1
    }
    body = body.subarray(0, end)
  }
  return { kind: 'text', text: body.toString('utf8'), language: languageOf(path), size, truncated }
}

function errorText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'файла нет'
  if (code === 'EACCES' || code === 'EPERM') return 'нет доступа'
  if (code === 'EISDIR') return 'это папка'
  return error instanceof Error ? error.message : String(error)
}

/** A local file for the viewer: only an absolute path; nothing is ever written. */
export async function readLocal(path: string): Promise<ViewerContent> {
  if (!isAbsolute(path)) return { kind: 'error', message: 'путь не абсолютный' }
  try {
    const info = await stat(path)
    if (info.isDirectory()) return { kind: 'error', message: 'это папка' }
    const want = Math.min(info.size, viewerLimit(path) + 1)
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(want)
      const { bytesRead } = await handle.read(head, 0, want, 0)
      return toViewerContent(path, head.subarray(0, bytesRead), info.size)
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { kind: 'error', message: errorText(error) }
  }
}
