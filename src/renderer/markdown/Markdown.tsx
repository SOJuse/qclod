import { createContext, useContext, useMemo } from 'react'
import type { ResolvedPath } from '../../shared/types'
import { pathTexts } from '../paths/linkify'
import { LinkedText } from '../paths/PathLink'
import { useResolvedPaths } from '../paths/useResolvedPaths'
import { parseMarkdown, type Block, type ListItem, type Span } from './parse'
import { highlight } from './highlight'
import './Markdown.css'

/** The tab whose folder the paths in this text are relative to, and which of them exist. */
const Paths = createContext<{ tabId: string; resolved: ReadonlyMap<string, ResolvedPath> } | null>(null)

/**
 * The path candidates of an answer: its text and inline code. A code block
 * is code, not a mention; a link's words are the link's.
 */
function candidateTexts(blocks: Block[]): string[] {
  const out = new Set<string>()
  const spans = (list: Span[]): void => {
    for (const span of list) {
      if (span.kind === 'text') for (const t of pathTexts(span.text)) out.add(t)
      else if (span.kind === 'code') for (const t of pathTexts(span.text, true)) out.add(t)
      else if (span.kind !== 'link') spans(span.spans)
    }
  }
  const walk = (list: Block[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          spans(block.spans)
          break
        case 'list':
          for (const item of block.items) {
            spans(item.spans)
            walk(item.children)
          }
          break
        case 'quote':
          walk(block.blocks)
          break
        case 'table':
          for (const cell of block.head) spans(cell)
          for (const row of block.rows) for (const cell of row) spans(cell)
          break
        default:
          break
      }
    }
  }
  walk(blocks)
  return [...out]
}

/**
 * Renders what the agent wrote the way it meant it.
 *
 * Everything here is React elements built from parsed data — there is no HTML
 * string anywhere, so nothing in an answer can become markup. A link opens in
 * the browser rather than navigating the window away from the app.
 */
export function Markdown({
  text,
  tabId,
  streaming = false
}: {
  text: string
  /** Paths in the text become links for this tab; without it the text stays text. */
  tabId?: string
  /** A text still being written asks nothing: half a path is not worth a lookup. */
  streaming?: boolean
}): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const raws = useMemo(() => (tabId && !streaming ? candidateTexts(blocks) : []), [blocks, tabId, streaming])
  const resolved = useResolvedPaths(tabId ?? '', raws)
  const paths = useMemo(() => (tabId ? { tabId, resolved } : null), [tabId, resolved])
  return (
    <Paths.Provider value={paths}>
      <div className="md">{blocks.map(renderBlock)}</div>
    </Paths.Provider>
  )
}

/** Text, with the paths in it as links where the context knows of any. */
function Linked({ text, code = false }: { text: string; code?: boolean }): JSX.Element {
  const paths = useContext(Paths)
  if (!paths || paths.resolved.size === 0) return <>{text}</>
  return <LinkedText tabId={paths.tabId} text={text} resolved={paths.resolved} code={code} />
}

function renderBlock(block: Block, index: number): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(6, block.level + 1)}`) as 'h2'
      return (
        <Tag key={index} className={`md-h md-h${block.level}`}>
          {block.spans.map(renderSpan)}
        </Tag>
      )
    }

    case 'code':
      return <CodeBlock key={index} language={block.language} code={block.code} />

    case 'list':
      return block.ordered ? (
        <ol key={index} className="md-list" start={block.start}>
          {block.items.map(renderItem)}
        </ol>
      ) : (
        <ul key={index} className="md-list">
          {block.items.map(renderItem)}
        </ul>
      )

    case 'quote':
      return (
        <blockquote key={index} className="md-quote">
          {block.blocks.map(renderBlock)}
        </blockquote>
      )

    case 'rule':
      return <hr key={index} className="md-rule" />

    case 'table':
      return (
        <div key={index} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, at) => (
                  <th key={at}>{cell.map(renderSpan)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowAt) => (
                <tr key={rowAt}>
                  {row.map((cell, at) => (
                    <td key={at}>{cell.map(renderSpan)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    default:
      return (
        <p key={index} className="md-p">
          {block.spans.map(renderSpan)}
        </p>
      )
  }
}

function renderItem(item: ListItem, index: number): JSX.Element {
  return (
    <li key={index} className={item.checked === undefined ? undefined : 'md-task'}>
      {item.checked !== undefined && (
        <span className={`md-check${item.checked ? ' is-done' : ''}`} aria-hidden>
          {item.checked ? '✓' : ''}
        </span>
      )}
      {item.spans.map(renderSpan)}
      {item.children.map(renderBlock)}
    </li>
  )
}

function renderSpan(span: Span, index: number): JSX.Element {
  switch (span.kind) {
    case 'code':
      return (
        <code key={index} className="md-code">
          <Linked text={span.text} code />
        </code>
      )
    case 'strong':
      return <strong key={index}>{span.spans.map(renderSpan)}</strong>
    case 'em':
      return <em key={index}>{span.spans.map(renderSpan)}</em>
    case 'strike':
      return <s key={index}>{span.spans.map(renderSpan)}</s>
    case 'link':
      return (
        <a
          key={index}
          className="md-link"
          href={safeHref(span.href)}
          onClick={(e) => {
            // The window is the app; a link belongs in the browser.
            e.preventDefault()
            void window.qclod.openExternal(span.href)
          }}
        >
          {span.spans.map(renderSpan)}
        </a>
      )
    default:
      return (
        <span key={index}>
          <Linked text={span.text} />
        </span>
      )
  }
}

/** Only http(s) ever becomes a real href; anything else is inert text. */
function safeHref(href: string): string | undefined {
  return /^https?:\/\//i.test(href) ? href : undefined
}

function CodeBlock({ language, code }: { language: string; code: string }): JSX.Element {
  const lines = useMemo(() => highlight(code, language), [code, language])

  return (
    <div className="md-codeblock" data-testid="md-code">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{language || 'код'}</span>
        <button
          type="button"
          className="md-copy"
          data-testid="md-copy"
          onClick={() => void navigator.clipboard.writeText(code)}
        >
          копировать
        </button>
      </div>
      <pre className="md-pre">
        <code>
          {lines.map((line, at) => (
            <span key={at} className="md-line">
              {line.map((token, tokenAt) => (
                <span key={tokenAt} className={`tok-${token.kind}`}>
                  {token.text}
                </span>
              ))}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
