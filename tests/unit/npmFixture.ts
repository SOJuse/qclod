import { copyFileSync, linkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A global npm install of Claude Code, laid out the way npm lays it out:
 * a `claude` sh script, a `claude.cmd` wrapper (cmd-shim's real text), and the
 * file the wrapper points at. For `exe` that file is node.exe under another
 * name, so a test can actually start it. Returns the path of that file.
 */
export function npmFixture(root: string, kind: 'exe' | 'js'): string {
  const pkg = join(root, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(join(pkg, 'bin'), { recursive: true })

  writeFileSync(
    join(root, 'claude'),
    '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n' +
      'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"\n',
    'utf8'
  )

  const head =
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'

  if (kind === 'exe') {
    const target = join(pkg, 'bin', 'claude.exe')
    try {
      linkSync(process.execPath, target)
    } catch {
      copyFileSync(process.execPath, target)
    }
    writeFileSync(
      join(root, 'claude.cmd'),
      head +
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
      'utf8'
    )
    return target
  }

  const target = join(pkg, 'cli.js')
  writeFileSync(target, "console.log('1.0.99 (Claude Code)')\n", 'utf8')
  writeFileSync(
    join(root, 'claude.cmd'),
    head +
      '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n' +
      '  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    'utf8'
  )
  return target
}
