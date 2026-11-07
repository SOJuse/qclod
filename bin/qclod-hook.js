#!/usr/bin/env node
/**
 * The command Claude Code runs for each hook Qclod registers.
 *
 * Reads the hook event JSON on stdin, tags it with the tab it belongs to, and
 * forwards it to the running Qclod over a local named pipe.
 *
 * Usage: qclod-hook.js <pipe-path> <tab-id>
 *
 * It must never fail loudly: a hook that errors or hangs would disrupt the
 * agent itself, which matters far more than one missed status update.
 */
'use strict'

const net = require('node:net')

const [pipePath, tabId] = process.argv.slice(2)
const TIMEOUT_MS = 2000

function done() {
  process.exit(0)
}

if (!pipePath || !tabId) done()

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})

process.stdin.on('end', () => {
  let event = {}
  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) event = parsed
  } catch {
    /* send what we know anyway: the tab and the fact that something happened */
  }

  const payload = JSON.stringify({ ...event, tabId })
  const socket = net.connect(pipePath, () => socket.end(payload, done))
  socket.on('error', done)
  socket.setTimeout(TIMEOUT_MS, done)
})

process.stdin.on('error', done)
setTimeout(done, TIMEOUT_MS * 2).unref()
