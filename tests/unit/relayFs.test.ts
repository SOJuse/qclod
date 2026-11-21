import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFileIndex } from '../../src/core/fileIndex'
import { RelayError } from '../../src/relay/errors'
import { indexFiles, listDir, readChunk, statMany, UPLOAD_MAX, writeUpload } from '../../src/relay/fsOps'
import { cleanTemps, tempDir } from './relayHarness'

afterEach(cleanTemps)

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (error) {
    return error instanceof RelayError ? error.code : 'other'
  }
  return 'ok'
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('файлы на сервере', () => {
  test("listDir('~') раскрывает домашнюю; папки первыми, скрытые в конце", async () => {
    const home = tempDir('qclod-home-')
    mkdirSync(join(home, 'zeta'))
    mkdirSync(join(home, 'alpha'))
    mkdirSync(join(home, '.config'))
    writeFileSync(join(home, 'b.txt'), 'bb')
    writeFileSync(join(home, '.bashrc'), '')
    const list = await listDir('~', home)
    expect(list.path).toBe(home)
    expect(list.truncated).toBe(false)
    expect(list.entries.map((e) => e.name)).toEqual(['alpha', 'zeta', 'b.txt', '.config', '.bashrc'])
    expect(list.entries[2]).toMatchObject({ kind: 'file', size: 2 })
    expect(list.entries[0]!.kind).toBe('dir')
    expect(typeof list.entries[0]!.mtime).toBe('number')
    expect((await listDir('~/alpha', home)).path).toBe(join(home, 'alpha'))
  })

  test('2500 файлов → 2000 и truncated; папки первыми', async () => {
    const home = tempDir('qclod-home-')
    const dir = join(home, 'many')
    mkdirSync(dir)
    for (let i = 0; i < 2500; i++) writeFileSync(join(dir, `f${String(i).padStart(4, '0')}`), '')
    mkdirSync(join(dir, 'zz-dir'))
    const list = await listDir(dir, home)
    expect(list.entries).toHaveLength(2000)
    expect(list.truncated).toBe(true)
    expect(list.entries[0]).toMatchObject({ name: 'zz-dir', kind: 'dir' })
  })

  test('нет папки — not_found', async () => {
    const home = tempDir('qclod-home-')
    expect(await code(listDir(join(home, 'нет'), home))).toBe('not_found')
  })

  test('statMany с относительным, абсолютным и несуществующим путём', async () => {
    const home = tempDir('qclod-home-')
    mkdirSync(join(home, 'app', 'src'), { recursive: true })
    writeFileSync(join(home, 'app', 'src', 'a.ts'), 'x')
    const result = await statMany('~/app', ['src/a.ts', join(home, 'app', 'src'), 'нет.ts', '~/app/src/a.ts'], home)
    expect(result).toEqual([
      { abs: join(home, 'app', 'src', 'a.ts'), kind: 'file' },
      { abs: join(home, 'app', 'src'), kind: 'dir' },
      null,
      { abs: join(home, 'app', 'src', 'a.ts'), kind: 'file' }
    ])
    expect(await code(statMany(home, Array.from({ length: 201 }, () => 'a'), home))).toBe('bad_request')
  })

  test('readChunk у конца файла даёт eof; length 300 КиБ — ошибка', async () => {
    const home = tempDir('qclod-home-')
    const file = join(home, 'f.bin')
    writeFileSync(file, Buffer.from('0123456789'))
    expect(await readChunk(file, 0, 4)).toEqual({ dataBase64: Buffer.from('0123').toString('base64'), size: 10, eof: false })
    expect(await readChunk(file, 6, 100)).toEqual({ dataBase64: Buffer.from('6789').toString('base64'), size: 10, eof: true })
    expect(await readChunk(file, 10, 4)).toEqual({ dataBase64: '', size: 10, eof: true })
    expect(await code(readChunk(file, 0, 300 * 1024))).toBe('bad_request')
    expect(await code(readChunk(file, -1, 4))).toBe('bad_request')
    expect(await code(readChunk(join(home, 'нет'), 0, 4))).toBe('not_found')
  })

  test("writeUpload('../../x') — bad_request; два чанка складываются в один файл", async () => {
    const uploads = tempDir('qclod-up-')
    expect(await code(writeUpload(uploads, 's1', '../../x', 0, Buffer.from('x'), true))).toBe('bad_request')
    expect(await code(writeUpload(uploads, '../s', 'x', 0, Buffer.from('x'), true))).toBe('bad_request')
    const first = await writeUpload(uploads, 's1', 'отчёт report?.pdf', 0, Buffer.from('hello '), false)
    // letters of any script stay; only what is no letter, digit or [_.- ] goes
    expect(first.path).toBe(join(uploads, 's1', '1-отчёт report_.pdf'))
    const second = await writeUpload(uploads, 's1', 'отчёт report?.pdf', 6, Buffer.from('world'), true, first.path)
    expect(second.path).toBe(first.path)
    expect(readFileSync(first.path, 'utf8')).toBe('hello world')
    // a second upload of the same name gets the next number
    const again = await writeUpload(uploads, 's1', 'отчёт report?.pdf', 0, Buffer.from('x'), true)
    expect(again.path).toBe(join(uploads, 's1', '2-отчёт report_.pdf'))
    // a chunk that does not continue a file is refused: no path, a wrong size, a path elsewhere
    expect(await code(writeUpload(uploads, 's1', 'other.txt', 5, Buffer.from('x'), true))).toBe('bad_request')
    expect(await code(writeUpload(uploads, 's1', 'x', 3, Buffer.from('x'), true, first.path))).toBe('bad_request')
    writeFileSync(join(uploads, 'outside.txt'), 'hello ')
    expect(await code(writeUpload(uploads, 's1', 'x', 6, Buffer.from('x'), true, join(uploads, 'outside.txt')))).toBe(
      'bad_request'
    )
    expect(await code(writeUpload(uploads, 's2', 'x', 6, Buffer.from('x'), true, first.path))).toBe('bad_request')
  })

  test('два файла с одним именем параллельно — каждый в свой файл, без склейки', async () => {
    const uploads = tempDir('qclod-up-')
    const a = [Buffer.alloc(8, 'a'), Buffer.alloc(8, 'A')]
    const b = [Buffer.alloc(8, 'b'), Buffer.alloc(8, 'B')]
    const send = async (parts: Buffer[]): Promise<string> => {
      let path: string | undefined
      let offset = 0
      for (const [i, part] of parts.entries()) {
        const res = await writeUpload(uploads, 's1', 'отчёт.txt', offset, part, i === parts.length - 1, path)
        path = res.path
        offset += part.length
        // the other upload gets its turn between the chunks
        await new Promise((r) => setTimeout(r, 5))
      }
      return path!
    }
    const [pa, pb] = await Promise.all([send(a), send(b)])
    expect(pa).not.toBe(pb)
    expect(readFileSync(pa, 'utf8')).toBe('aaaaaaaaAAAAAAAA')
    expect(readFileSync(pb, 'utf8')).toBe('bbbbbbbbBBBBBBBB')
    expect([pa, pb].map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['1-отчёт.txt', '2-отчёт.txt'])
  })

  test('имя загрузки — не длиннее 120 знаков; больше 100 МБ — too_large', async () => {
    const uploads = tempDir('qclod-up-')
    const { path } = await writeUpload(uploads, 's1', 'a'.repeat(300) + '.txt', 0, Buffer.from('x'), true)
    expect(path.split(/[\\/]/).pop()!.length).toBe('1-'.length + 120)
    const big = await writeUpload(uploads, 's1', 'big.bin', 0, Buffer.alloc(16), false)
    // the size is checked before anything is written or looked for
    expect(await code(writeUpload(uploads, 's1', 'big.bin', UPLOAD_MAX, Buffer.alloc(1), true, big.path))).toBe('too_large')
    expect(await code(writeUpload(uploads, 's1', 'big.bin', 16, Buffer.alloc(16), true, big.path))).toBe('ok')
  })

  test.runIf(process.platform !== 'win32')('ссылка из uploads наружу — bad_request', async () => {
    const uploads = tempDir('qclod-up-')
    const outside = tempDir('qclod-out-')
    symlinkSync(outside, join(uploads, 's1'))
    expect(await code(writeUpload(uploads, 's1', 'x.txt', 0, Buffer.from('x'), true))).toBe('bad_request')
  })

  test.runIf(hasGit())('indexFiles в git-репозитории учитывает .gitignore', async () => {
    const root = tempDir('qclod-git-')
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'secret.txt\nbuild/\n')
    writeFileSync(join(root, 'a.txt'), '')
    writeFileSync(join(root, 'secret.txt'), '')
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.js'), '')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'b.ts'), '')
    const all = await indexFiles(root, 100)
    expect(all.truncated).toBe(false)
    expect([...all.files].sort()).toEqual(['.gitignore', 'a.txt', 'src/b.ts'])
    const one = await indexFiles(root, 1)
    expect(one).toEqual({ files: [one.files[0]], truncated: true })
  })

  test.runIf(hasGit())('indexFiles не запускает fsmonitor из .git/config чужой папки', async () => {
    const root = tempDir('qclod-git-')
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, 'a.txt'), '')
    execFileSync('git', ['add', 'a.txt'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: root })
    execFileSync('git', ['config', 'core.fsmonitor', 'echo ran > fsm-marker; false'], { cwd: root })
    const { files } = await indexFiles(root, 100)
    expect(files).toContain('a.txt')
    expect(existsSync(join(root, 'fsm-marker'))).toBe(false)
  })

  test('indexFiles без git — core/fileIndex', async () => {
    const root = tempDir('qclod-plain-')
    writeFileSync(join(root, '.gitignore'), 'skip.txt\n')
    writeFileSync(join(root, 'keep.txt'), '')
    writeFileSync(join(root, 'skip.txt'), '')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'x.js'), '')
    const result = await indexFiles(root, 100)
    expect(result.files.sort()).toEqual((await buildFileIndex(root)).sort())
    expect(result.files).toContain('keep.txt')
    expect(result.files).not.toContain('skip.txt')
    expect(result.truncated).toBe(false)
  })
})
