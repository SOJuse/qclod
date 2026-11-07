/** Reads real past sessions off disk: no tokens, no network, just shapes. */
const sdk = await import('@anthropic-ai/claude-agent-sdk')

const sessions = await sdk.listSessions({ dir: process.cwd() })
console.log('сессий:', sessions.length)
if (sessions.length === 0) process.exit(0)

const first = sessions[0]
console.log('ключи SessionInfo:', Object.keys(first).join(', '))

const messages = await sdk.getSessionMessages(first.sessionId)
console.log('сообщений:', messages.length)
console.log('типы:', [...new Set(messages.map((m) => m?.type))].join(', '))

for (const m of messages.slice(0, 3)) {
  console.log('---')
  console.log('ключи:', Object.keys(m).join(', '))
  console.log(JSON.stringify(m).slice(0, 400))
}
