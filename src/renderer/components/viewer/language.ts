/**
 * The highlighter's language name for a file, by its name: an extension it
 * knows by family (`py`, `sh`, `yaml`, `sql`…), or the extension itself, or
 * '' (the highlighter then guesses comments from both families).
 */
export function languageOf(path: string): string {
  const name = (path.split(/[\/]/).pop() ?? '').toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return name
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot + 1)
  if (ext === 'yml') return 'yaml'
  if (ext === 'bash' || ext === 'zsh') return 'sh'
  if (ext === 'rb') return 'ruby'
  return ext
}
