// Probe: the one-off query behind «Собрать мои шаблоны» (no tools, 1 turn,
// no settings, not persisted, budget cap, timeout). Synthetic prompts only.
// Run: node scripts/probe-oneshot.mjs [--nologin]
// SDK is resolved from QCLOD_SDK (path to the Agent SDK entry) if set.
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sdkEntry =
  process.env.QCLOD_SDK ??
  'C:/Users/sojuse/qclod/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
const { query } = await import(pathToFileURL(sdkEntry).href)

const AGENT =
  'C:/Users/sojuse/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe'
const noLogin = process.argv.includes('--nologin')
const cwd = mkdtempSync(join(tmpdir(), 'qclod-oneshot-'))
const projDir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const list = () => (existsSync(projDir) ? readdirSync(projDir) : [])
console.log('cwd', cwd, '\nprojDir', projDir, '\nbefore', JSON.stringify(list()))

const msgs = [
  'сделай ревью ветки feature/login и перечисли проблемы',
  'сделай ревью ветки feature/cart и перечисли проблемы',
  'напиши тесты для модуля parser.ts, покрой граничные случаи',
  'напиши тесты для модуля lexer.ts, покрой граничные случаи',
  'переведи README на английский'
]
const prompt =
  'Ниже сообщения пользователя. Найди повторяющиеся просьбы и верни ТОЛЬКО JSON-массив объектов {"title","text"} — шаблоны.\n\n' +
  msgs.map((m, i) => `${i + 1}. ${m}`).join('\n')

const env = { ...process.env }
if (noLogin) {
  const empty = mkdtempSync(join(tmpdir(), 'qclod-emptycfg-'))
  env.CLAUDE_CONFIG_DIR = empty
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  console.log('CLAUDE_CONFIG_DIR', empty)
}

const t0 = Date.now()
const ac = new AbortController()
const timer = setTimeout(() => ac.abort(), 90_000)
const q = query({
  prompt,
  options: {
    pathToClaudeCodeExecutable: AGENT,
    cwd,
    env,
    abortController: ac,
    tools: [],
    maxTurns: 1,
    settingSources: [],
    persistSession: false,
    maxBudgetUsd: 0.05,
    model: 'haiku',
    systemPrompt: 'Ты извлекаешь шаблоны запросов. Отвечай только JSON-массивом, без пояснений.'
  }
})
try {
  for await (const m of q) {
    console.log(JSON.stringify(m).slice(0, 1800))
  }
} catch (e) {
  console.log('THROWN', e?.name, String(e?.message ?? e))
} finally {
  clearTimeout(timer)
  try { q.close?.() } catch {}
}
console.log('elapsed_ms', Date.now() - t0, '\nafter', JSON.stringify(list()))
