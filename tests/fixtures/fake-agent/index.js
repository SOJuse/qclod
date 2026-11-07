#!/usr/bin/env node
/**
 * Fake Claude Code agent.
 *
 * Stands in for the real CLI in every automated test so the suite is
 * deterministic, needs no account, no network and spends no tokens. It speaks
 * the parts of the real TUI's contract that Qclod depends on: bracketed paste,
 * a bottom prompt line, an arrow-driven selection menu, hooks invoked from
 * --settings, and a real exit code.
 *
 * Machine-readable markers (ready, [submit N], menu-open, menu-selected) exist
 * so tests can assert without screen-scraping a redrawn TUI.
 */
'use strict'

const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const PASTE_START = '[200~'
const PASTE_END = '[201~'
const MENU_OPTIONS = ['option-1', 'option-2', 'option-3']

const argv = process.argv.slice(2)
const sessionId = randomUUID()
const settings = parseSettings(argv)

let buffer = ''
let pending = ''
let inPaste = false
let submits = 0
let menu = null

function parseSettings(args) {
  const i = args.indexOf('--settings')
  if (i === -1 || !args[i + 1]) return {}
  try {
    return JSON.parse(args[i + 1])
  } catch {
    return {}
  }
}

function out(text) {
  process.stdout.write(text)
}

function prompt() {
  out(`\r\n› ${buffer}`)
}

/** Mirrors the real CLI: hooks come from the resolved settings, by event name. */
function fireHook(eventName, extra = {}) {
  const entries = settings?.hooks?.[eventName]
  if (!Array.isArray(entries)) return
  const payload = JSON.stringify({
    hook_event_name: eventName,
    session_id: sessionId,
    cwd: process.cwd(),
    ...extra
  })
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== 'command' || !hook.command) continue
      const child = spawn(hook.command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] })
      child.stdin.end(payload)
    }
  }
}

function openMenu() {
  menu = 0
  out('\r\nmenu-open\r\n')
  renderMenu()
}

function renderMenu() {
  for (let i = 0; i < MENU_OPTIONS.length; i++) {
    out(`\r\n${i === menu ? '❯' : ' '} ${MENU_OPTIONS[i]}`)
  }
  out('\r\nEnter to confirm · Esc to cancel\r\n')
}

function submit() {
  const text = buffer
  buffer = ''
  if (text.trim() === '') {
    prompt()
    return
  }
  if (text.startsWith('/exit')) {
    const code = Number.parseInt(text.slice('/exit'.length).trim(), 10)
    fireHook('SessionEnd')
    setTimeout(() => process.exit(Number.isNaN(code) ? 0 : code), 30)
    return
  }
  if (text.startsWith('/menu')) {
    openMenu()
    return
  }
  if (text.startsWith('/ask')) {
    fireHook('Notification', { matcher: 'permission_prompt' })
    out('\r\nwaiting-for-permission\r\n')
    prompt()
    return
  }
  submits += 1
  out(`\r\n⏺ echo: ${JSON.stringify(text)}\r\n[submit ${submits}]\r\n`)
  fireHook('Stop', { last_assistant_message: `echo: ${text}` })
  prompt()
}

function handleMenuKey(seq) {
  if (seq === '[A') {
    menu = (menu + MENU_OPTIONS.length - 1) % MENU_OPTIONS.length
    renderMenu()
  } else if (seq === '[B') {
    menu = (menu + 1) % MENU_OPTIONS.length
    renderMenu()
  } else if (seq === '\r' || seq === '\n') {
    const chosen = MENU_OPTIONS[menu]
    menu = null
    out(`\r\nmenu-selected: ${chosen}\r\n`)
    fireHook('Stop', { last_assistant_message: `menu-selected: ${chosen}` })
    prompt()
  } else if (seq === '') {
    menu = null
    out('\r\nmenu-cancelled\r\n')
    prompt()
  }
}

/**
 * One pass over everything buffered so far. Escape sequences can be split
 * across chunks, so an incomplete tail is kept in `pending` for the next pass.
 */
function consume() {
  while (pending.length > 0) {
    if (inPaste) {
      const end = pending.indexOf(PASTE_END)
      if (end === -1) {
        // Hold back a possible partial end marker.
        const keep = Math.max(0, pending.length - PASTE_END.length + 1)
        buffer += pending.slice(0, keep)
        pending = pending.slice(keep)
        return
      }
      buffer += pending.slice(0, end)
      pending = pending.slice(end + PASTE_END.length)
      inPaste = false
      continue
    }

    if (pending.startsWith(PASTE_START)) {
      pending = pending.slice(PASTE_START.length)
      inPaste = true
      continue
    }

    const ch = pending[0]

    if (ch === '') {
      if (PASTE_START.startsWith(pending)) return // partial marker, wait
      const arrow = /^\[[A-D]/.exec(pending)
      if (arrow) {
        pending = pending.slice(arrow[0].length)
        if (menu !== null) handleMenuKey(arrow[0])
        continue
      }
      if (pending.length === 1) return // bare ESC may still grow
      pending = pending.slice(1)
      if (menu !== null) handleMenuKey('')
      continue
    }

    pending = pending.slice(1)

    if (ch === '') {
      fireHook('SessionEnd')
      setTimeout(() => process.exit(130), 20)
      return
    }
    if (menu !== null) {
      handleMenuKey(ch)
      continue
    }
    if (ch === '\r' || ch === '\n') {
      submit()
      continue
    }
    if (ch === '' || ch === '\b') {
      buffer = buffer.slice(0, -1)
      prompt()
      continue
    }
    buffer += ch
    out(ch)
  }
}

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  consume()
})

out('fake-agent ready\r\n')
prompt()
