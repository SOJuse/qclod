import { afterEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RelayDaemon } from '../../src/relay/daemon'
import { relayMethods } from '../../src/relay/methods'
import { relayPaths } from '../../src/relay/paths'
import { RelayClient } from '../../src/main/ssh/relayClient'
import { socketTransport } from '../../src/main/ssh/transport'
import { READ_CHUNK, downloadRemote, readRemote, type RelayReader } from '../../src/main/ssh/remoteFiles'
import { cleanTemps, fakeFactory, tempDir } from './relayHarness'

const daemons: RelayDaemon[] = []
const clients: RelayClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.stop()
  cleanTemps()
})

/** A real daemon with the file methods, and a RelayClient on its socket. */
async function server(): Promise<{ root: string; client: RelayClient; reads: number[] }> {
  const root = tempDir('qclod-rfiles-')
  const paths = relayPaths(root, process.platform, join(root, '.qclod'))
  const daemon = new RelayDaemon({
    paths,
    version: '1.0.0-test',
    createDriver: fakeFactory().factory,
    claudePath: () => '/bin/claude',
    exit: () => undefined,
    home: root,
    methods: relayMethods({
      run: async () => ({ code: 1, stdout: '' }),
      version: '1.0.0-test',
      claudePath: () => null,
      home: root,
      listSessions: async () => []
    })
  })
  daemons.push(daemon)
  await daemon.start()
  const client = new RelayClient({ hostId: 'h1', appVersion: '1.0.0', clientName: 'vitest', transport: socketTransport(paths.socket) })
  clients.push(client)
  await client.connect(false)
  const reads: number[] = []
  const call = client.call.bind(client)
  ;(client as unknown as { call: RelayReader['call'] }).call = (m, p, o) => {
    if (m === 'fs.read') reads.push((p as { offset: number }).offset)
    return call(m, p, o)
  }
  return { root, client, reads }
}

describe('файлы сервера для просмотра', () => {
  test('readRemote на демоне читает файл из 3 чанков и склеивает верно', async () => {
    const { root, client, reads } = await server()
    const text = Array.from({ length: 19_000 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`).join('\n')
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(bytes).toBeGreaterThan(2 * READ_CHUNK)
    expect(bytes).toBeLessThan(3 * READ_CHUNK)
    const file = join(root, 'big.ts')
    writeFileSync(file, text)
    const content = await readRemote(client, file)
    expect(reads).toEqual([0, READ_CHUNK, 2 * READ_CHUNK])
    expect(content).toEqual({ kind: 'text', text, language: 'typescript', size: bytes, truncated: false })
  })

  test('нет файла — error', async () => {
    const { root, client } = await server()
    const content = await readRemote(client, join(root, 'нет.txt'))
    expect(content.kind).toBe('error')
  })

  test('downloadRemote кладёт файл по правилу пути', async () => {
    const { root, client } = await server()
    const file = join(root, 'report.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.4 образец'))
    const userData = tempDir('qclod-ud-')
    const local = await downloadRemote(client, 'h1', file, userData)
    const sha = createHash('sha1').update(file).digest('hex')
    expect(local).toBe(join(userData, 'remote-files', 'h1', sha, 'report.pdf'))
    expect(readFileSync(local, 'utf8')).toBe('%PDF-1.4 образец')
  })
})
