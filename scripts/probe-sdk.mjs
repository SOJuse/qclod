// Probe: does the Agent SDK resolve `@path` in a prompt the way the TUI does?
//
// Three features ride on this — the paperclip, pasting a file from Explorer,
// and @-mentions — so it is the first thing checked, before anything is built
// on top of it. Also records the real shape of the messages the ribbon
// translator will consume.
//
// Run: node scripts/probe-sdk.mjs
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AGENT =
  'C:/Users/user/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe'

// A throwaway project with a file whose contents are unguessable, so "the
// agent read it" cannot be confused with "the agent guessed".
const root = mkdtempSync(join(tmpdir(), 'qclod-probe-'))
mkdirSync(join(root, 'Мои файлы'), { recursive: true })
const SECRET = 'ZARANTHOS-' + Math.random().toString(36).slice(2, 10).toUpperCase()
writeFileSync(join(root, 'plain.txt'), `secret code: ${SECRET}\n`, 'utf8')
writeFileSync(join(root, 'Мои файлы', 'файл 1.txt'), `spaced code: ${SECRET}-SP\n`, 'utf8')

const seen = { types: new Set(), tools: [], text: '', init: null, result: null, rateLimit: null }

async function run(label, prompt, extra = {}) {
  seen.types.clear()
  seen.tools = []
  seen.text = ''
  console.log(`\n=== ${label} ===`)

  const q = query({
    prompt,
    options: {
      cwd: root,
      pathToClaudeCodeExecutable: AGENT,
      permissionMode: 'bypassPermissions',
      maxTurns: 2,
      ...extra
    }
  })

  for await (const m of q) {
    seen.types.add(`${m.type}${m.subtype ? '/' + m.subtype : ''}`)
    if (m.type === 'system' && m.subtype === 'init') seen.init = m
    if (m.type === 'rate_limit_event') seen.rateLimit = m.rate_limit_info
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text') seen.text += block.text
        if (block.type === 'tool_use') seen.tools.push({ name: block.name, input: block.input })
      }
    }
    if (m.type === 'result') seen.result = m
  }

  console.log('message kinds :', [...seen.types].join(', '))
  console.log('tools called  :', seen.tools.map((t) => t.name).join(', ') || '(none)')
  console.log('reply (trim)  :', seen.text.replace(/\s+/g, ' ').slice(0, 240))
  return seen.text
}

// 1. The question that decides the composer: does @path make it read the file?
const plain = await run('@path, no spaces', `Что написано в @plain.txt ? Ответь одной строкой.`)
console.log('>>> RESOLVED @path   :', plain.includes(SECRET) ? 'YES' : 'NO')

// 2. Same, with a path that contains a space and Cyrillic.
const spaced = await run(
  '@path with spaces (quoted)',
  `Что написано в @"Мои файлы/файл 1.txt" ? Ответь одной строкой.`
)
console.log('>>> RESOLVED quoted  :', spaced.includes(SECRET + '-SP') ? 'YES' : 'NO')

// 3. Control: no @, just the bare name — proves the @ is what did the work.
const bare = await run('bare filename, no @', `Что написано в plain.txt ? Ответь одной строкой.`)
console.log('>>> bare name worked :', bare.includes(SECRET) ? 'YES (agent used a tool)' : 'NO')

console.log('\n=== session surfaces ===')
console.log('init keys     :', seen.init ? Object.keys(seen.init).sort().join(', ') : '(none)')
if (seen.init) {
  console.log('model         :', seen.init.model)
  console.log('permissionMode:', seen.init.permissionMode ?? seen.init.permission_mode)
  console.log('mcp_servers   :', JSON.stringify(seen.init.mcp_servers))
  console.log('slash_commands:', (seen.init.slash_commands ?? []).length, 'entries')
}
console.log('result keys   :', seen.result ? Object.keys(seen.result).sort().join(', ') : '(none)')
if (seen.result) {
  console.log('usage         :', JSON.stringify(seen.result.usage))
  console.log('cost_usd      :', seen.result.total_cost_usd)
  console.log('context_usage :', JSON.stringify(seen.result.context_usage)?.slice(0, 300))
}
console.log('rate_limit    :', JSON.stringify(seen.rateLimit))
console.log('\nprobe root:', root)
