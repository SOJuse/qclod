// 1.0.1: vpn. Downloads the official Hysteria2 client (apernet/hysteria, MIT)
// into build/vendor/hysteria/ and checks its SHA-256 against the sums pinned
// below. electron-builder ships that folder as extraResources (hysteria/).
//   node scripts/fetch-hysteria.mjs [--platform win32|darwin|all]
// A mismatch is a stop: the file is deleted and the script fails.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HYSTERIA_VERSION = 'app/v2.14.0'

/** From the release's hashes.txt, checked by hand; a new version changes them here. */
export const HYSTERIA_ASSETS = {
  win32: {
    asset: 'hysteria-windows-amd64.exe',
    file: 'hysteria.exe',
    sha256: '6ee18e99f826670a249ad20400c536900cb6fb5369237e30768df9032ac92d80'
  },
  darwin: {
    asset: 'hysteria-darwin-arm64',
    file: 'hysteria',
    sha256: 'c68aa6677f15e572f997b346bcdf193b45a9dc9071b7e9555efffc8694c5ec05'
  }
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = join(root, 'build', 'vendor', 'hysteria')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchOne(platform) {
  const a = HYSTERIA_ASSETS[platform]
  const dest = join(dir, a.file)
  if (existsSync(dest) && sha256(readFileSync(dest)) === a.sha256) {
    console.log(`hysteria ${platform}: уже на месте`)
    return
  }
  const url = `https://github.com/apernet/hysteria/releases/download/${HYSTERIA_VERSION}/${a.asset}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`hysteria ${platform}: ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== a.sha256) throw new Error(`hysteria ${platform}: SHA-256 не совпал (${got})`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${dest}.part`
  writeFileSync(tmp, buf)
  if (platform === 'darwin') chmodSync(tmp, 0o755)
  rmSync(dest, { force: true })
  renameSync(tmp, dest)
  console.log(`hysteria ${platform}: ${HYSTERIA_VERSION}, ${buf.length} байт, SHA-256 сошёлся`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--platform')
  const want = i > 0 ? process.argv[i + 1] : process.platform
  const list = want === 'all' ? Object.keys(HYSTERIA_ASSETS) : [want]
  for (const p of list) {
    if (!HYSTERIA_ASSETS[p]) {
      console.error(`нет клиента для ${p}`)
      process.exit(1)
    }
    await fetchOne(p).catch((e) => {
      console.error(String(e.message ?? e))
      process.exit(1)
    })
  }
}
