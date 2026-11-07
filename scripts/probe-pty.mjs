// Probe 1 + 3: does the Claude Code TUI treat a bracketed-paste block as one
// input, and which SGR colours does it paint its own prompt box with?
//
// Deliberately never presses Enter: we inspect the composed input line and
// quit, so no turn is spent.
import { spawn } from '@lydell/node-pty'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT_DIR = resolve(process.cwd(), '.superpowers/probe')
mkdirSync(OUT_DIR, { recursive: true })

const agent = process.argv[2] ?? 'claude'
const cwd = process.argv[3] ?? process.cwd()

const p = spawn(agent, [], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' }
})

let raw = ''
p.onData((d) => {
  raw += d
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PASTE = '\x1b[200~' + 'line one\nline two\nline three' + '\x1b[201~'

async function run() {
  await sleep(6000) // let the TUI boot
  const beforeLen = raw.length
  p.write(PASTE)
  await sleep(2500)
  const afterPaste = raw.slice(beforeLen)

  writeFileSync(resolve(OUT_DIR, 'raw-full.txt'), raw, 'utf8')
  writeFileSync(resolve(OUT_DIR, 'raw-after-paste.txt'), afterPaste, 'utf8')

  // Count how many times the agent echoed a submitted prompt marker. If the
  // paste was split into separate submissions we would see the TUI react
  // three times instead of composing one multi-line buffer.
  const sawAllThree =
    afterPaste.includes('line one') &&
    afterPaste.includes('line two') &&
    afterPaste.includes('line three')

  const sgr = [...raw.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1])
  const counts = new Map()
  for (const s of sgr) counts.set(s, (counts.get(s) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)

  console.log('--- paste visible in one render:', sawAllThree)
  console.log('--- bytes captured after paste:', afterPaste.length)
  console.log('--- top SGR sequences (code -> count):')
  for (const [code, n] of top) console.log(`    ESC[${code}m  x${n}`)

  p.write('\x03')
  await sleep(300)
  p.write('\x03')
  await sleep(500)
  p.kill()
  process.exit(0)
}

run()
