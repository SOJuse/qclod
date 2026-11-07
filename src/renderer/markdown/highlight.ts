/**
 * Enough syntax colour to read code at a glance.
 *
 * Not a parser for any language: a tokeniser that knows strings, comments,
 * numbers and a shared pool of keywords. Being approximately right in every
 * language beats being exactly right in three and plain grey in the rest —
 * and it costs no dependency, which matters in a packaged app.
 */

export type TokenKind = 'plain' | 'string' | 'comment' | 'number' | 'keyword' | 'type' | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'def', 'default', 'del', 'delete', 'do', 'elif', 'else', 'end', 'enum', 'export',
  'extends', 'False', 'false', 'finally', 'fn', 'for', 'from', 'func', 'function', 'go', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'lambda', 'let', 'match',
  'mod', 'mut', 'namespace', 'new', 'nil', 'none', 'None', 'not', 'null', 'or', 'package',
  'pass', 'private', 'protected', 'public', 'pub', 'raise', 'readonly', 'return', 'select',
  'self', 'static', 'struct', 'super', 'switch', 'then', 'this', 'throw', 'True', 'true', 'try',
  'type', 'typeof', 'use', 'using', 'var', 'void', 'while', 'with', 'yield', 'and', 'elseif',
  'echo', 'fi', 'esac', 'done', 'local', 'set', 'unset', 'exit'
])

const TYPES = new Set([
  'boolean', 'bool', 'byte', 'char', 'double', 'float', 'int', 'int32', 'int64', 'long',
  'number', 'object', 'Promise', 'Record', 'string', 'str', 'symbol', 'uint', 'unknown',
  'Array', 'Map', 'Set', 'List', 'Dict', 'Option', 'Result', 'Vec'
])

/** Line comment openers, by family. `#` covers shell, Python, YAML, Ruby. */
function lineCommentFor(language: string): string[] {
  const lang = language.toLowerCase()
  if (/^(py|python|sh|bash|zsh|shell|yaml|yml|toml|ruby|rb|perl|r|makefile|dockerfile)$/.test(lang)) {
    return ['#']
  }
  if (/^(sql|lua|hs|haskell)$/.test(lang)) return ['--']
  if (lang === '') return ['//', '#']
  return ['//']
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

/** One array of tokens per line, so the renderer can keep line structure. */
export function highlight(code: string, language = ''): Token[][] {
  const comments = lineCommentFor(language)
  const blockComment = !/^(py|python|sh|bash|zsh|shell|yaml|yml|toml|ruby|rb)$/i.test(language)

  return code.split('\n').map((line) => tokenizeLine(line, comments, blockComment))
}

function tokenizeLine(line: string, comments: string[], blockComment: boolean): Token[] {
  const tokens: Token[] = []
  let plain = ''
  let i = 0

  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ kind: 'plain', text: plain })
      plain = ''
    }
  }

  const push = (kind: TokenKind, text: string): void => {
    flush()
    tokens.push({ kind, text })
  }

  while (i < line.length) {
    const rest = line.slice(i)

    const comment = comments.find((marker) => rest.startsWith(marker))
    if (comment) {
      push('comment', rest)
      i = line.length
      break
    }

    if (blockComment && rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2)
      const text = end === -1 ? rest : line.slice(i, end + 2)
      push('comment', text)
      i += text.length
      continue
    }

    const char = line[i]!

    if (char === '"' || char === "'" || char === '`') {
      let at = i + 1
      while (at < line.length) {
        if (line[at] === '\\') {
          at += 2
          continue
        }
        if (line[at] === char) {
          at++
          break
        }
        at++
      }
      push('string', line.slice(i, at))
      i = at
      continue
    }

    if (/[0-9]/.test(char) && !isWordChar(line[i - 1] ?? ' ')) {
      const number = /^0[xXbBoO][0-9a-fA-F_]+|^[0-9][0-9_]*(\.[0-9_]+)?([eE][-+]?[0-9]+)?/.exec(rest)
      if (number) {
        push('number', number[0])
        i += number[0].length
        continue
      }
    }

    if (isWordChar(char)) {
      let at = i
      while (at < line.length && isWordChar(line[at]!)) at++
      const word = line.slice(i, at)
      if (KEYWORDS.has(word)) push('keyword', word)
      else if (TYPES.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) push('type', word)
      else plain += word
      i = at
      continue
    }

    if (/[{}()[\].,;:=+\-*/%<>!&|^~?]/.test(char)) {
      push('punct', char)
      i++
      continue
    }

    plain += char
    i++
  }

  flush()
  return tokens
}
