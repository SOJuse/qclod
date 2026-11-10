import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { bytes, lines, plural, seconds } from '../../../shared/format'
import type { ToolCardItem, ToolView } from '../../../shared/toolView'
import { pathTexts } from '../../paths/linkify'
import { LinkedText, PathLink } from '../../paths/PathLink'
import { useResolvedPaths } from '../../paths/useResolvedPaths'
import { DiffView } from './DiffView'
import { RawJson } from './RawJson'

/** The tab whose folder the card's paths are relative to. */
const Tab = createContext('')

/**
 * What an opened tool card shows, by the kind of call: the facts of the call
 * as label and value, then its output in a bounded block. The raw input and
 * output sit folded at the bottom of every card.
 */
export function ToolBody({
  item,
  view,
  cwd,
  tabId
}: {
  item: ToolCardItem
  view: ToolView
  cwd: string
  tabId: string
}): JSX.Element {
  const error = item.kind === 'toolError' ? item.error : ''
  return (
    <Tab.Provider value={tabId}>
      <div className="tool-body" data-testid="tool-detail">
        {error && (
          <pre className="tool-pre tool-error" data-testid="tool-error">
            {error}
          </pre>
        )}
        <ViewBody item={item} view={view} cwd={cwd} />
        <RawJson item={item} />
      </div>
    </Tab.Provider>
  )
}

/** A whole path, as a link when it exists. */
function PathText({ path }: { path: string }): JSX.Element {
  const tabId = useContext(Tab)
  const raws = useMemo(() => (path ? [path] : []), [path])
  const target = useResolvedPaths(tabId, raws).get(path)
  return target ? (
    <PathLink tabId={tabId} target={target}>
      {path}
    </PathLink>
  ) : (
    <>{path}</>
  )
}

/** Output text with the paths in it as links. */
function OutputText({ text }: { text: string }): JSX.Element {
  const tabId = useContext(Tab)
  const raws = useMemo(() => pathTexts(text), [text])
  const resolved = useResolvedPaths(tabId, raws)
  return <LinkedText tabId={tabId} text={text} resolved={resolved} />
}

function ViewBody({ item, view, cwd }: { item: ToolCardItem; view: ToolView; cwd: string }): JSX.Element | null {
  const failed = item.kind === 'toolError'

  switch (view.type) {
    case 'command':
      return (
        <>
          <Facts>
            <Fact label="Команда">
              <code className="tool-mono tool-wrap">{view.command}</code>
            </Fact>
            {view.description && <Fact label="Зачем">{view.description}</Fact>}
            {cwd && (
              <Fact label="Папка">
                <span className="tool-mono" data-testid="tool-cwd">
                  {cwd}
                </span>
              </Fact>
            )}
            {view.note && <Fact label="Итог">{view.note}</Fact>}
            {view.interrupted && <Fact label="Итог">прервано</Fact>}
            {view.backgroundTaskId && <Fact label="В фоне">задача {view.backgroundTaskId}</Fact>}
            <Duration item={item} />
          </Facts>
          {view.stdout && <Output label="Вывод" testId="tool-stdout" text={view.stdout} />}
          {view.stderr && <Output label="Ошибки" testId="tool-stderr" text={view.stderr} />}
        </>
      )

    case 'edit':
      return (
        <>
          <Facts>
            <PathFact path={view.path} />
            <Fact label="Строки">{changed(view.added, view.removed)}</Fact>
          </Facts>
          {view.hunks.some((h) => h.lines.length > 0) && <DiffView hunks={view.hunks} />}
        </>
      )

    case 'write': {
      const more = view.totalLines - view.head.length
      return (
        <>
          <Facts>
            <PathFact path={view.path} />
            <Fact label="Файл">{view.created ? 'новый' : 'перезаписан'}</Fact>
            <Fact label="Размер">
              {bytes(view.size)}, {lines(view.totalLines)}
            </Fact>
          </Facts>
          {view.head.length > 0 && (
            <Numbered
              label={more > 0 ? `Первые ${view.head.length} ${plural(view.head.length, 'строка', 'строки', 'строк')}` : 'Содержимое'}
              start={1}
              rows={view.head}
            />
          )}
          {more > 0 && <p className="tool-more">и ещё {lines(more)}</p>}
        </>
      )
    }

    case 'read': {
      const last = view.startLine + view.numLines - 1
      return (
        <>
          <Facts>
            <PathFact path={view.path} />
            <Fact label="Строки">
              {view.numLines === 0
                ? 'пусто'
                : view.numLines < view.totalLines
                  ? `${view.startLine}–${last} из ${view.totalLines}`
                  : `все ${view.totalLines}`}
            </Fact>
          </Facts>
          {view.preview.length > 0 && <Numbered label="Начало" start={view.startLine} rows={view.preview} />}
        </>
      )
    }

    case 'search':
      return (
        <>
          <Facts>
            <Fact label="Запрос">
              <code className="tool-mono tool-wrap">{view.pattern}</code>
            </Fact>
            {view.where && (
              <Fact label="Где">
                <span className="tool-mono tool-wrap">{view.where}</span>
              </Fact>
            )}
            <Fact label="Найдено">{found(view)}</Fact>
          </Facts>
          {view.files.length > 0 && (
            <ul className="tool-list tool-mono" data-testid="tool-matches">
              {view.files.map((file, i) => (
                <li key={i} className="tool-match" data-testid="tool-match">
                  <PathText path={file} />
                </li>
              ))}
            </ul>
          )}
          {view.content && <Output label="Совпадения" text={view.content} />}
        </>
      )

    case 'web':
      return (
        <>
          <Facts>
            {view.url && (
              <Fact label="Адрес">
                <span className="tool-mono tool-wrap">{view.url}</span>
              </Fact>
            )}
            {view.query && <Fact label="Запрос">{view.query}</Fact>}
            {view.status && <Fact label="Ответ">{view.status}</Fact>}
            <Duration item={item} />
          </Facts>
          {view.results.length > 0 && (
            <ul className="tool-list" data-testid="tool-results">
              {view.results.map((r, i) => (
                <li key={i} className="tool-result">
                  <span className="tool-result-title">{r.title || r.url}</span>
                  {r.title && <span className="tool-result-url tool-mono">{r.url}</span>}
                </li>
              ))}
            </ul>
          )}
          {view.text && <Output label={view.url ? 'Что взято со страницы' : 'Ответ'} text={view.text} />}
        </>
      )

    case 'mcp':
      return (
        <>
          <Facts>
            <Fact label="Сервер">{view.server}</Fact>
            <Fact label="Инструмент">
              <span className="tool-mono">{view.tool}</span>
            </Fact>
            <Duration item={item} />
          </Facts>
          <Args args={view.args} />
          {/* A failed call's text is already shown on top as the error. */}
          {!failed && view.result && <Output label="Результат" text={view.result} />}
        </>
      )

    default:
      // A tool with no view of its own, an old record or a failed call: what
      // it was asked, then what came back.
      return (
        <>
          <Facts>
            <Duration item={item} />
          </Facts>
          <Args args={argRows(item.input ?? {}, INPUT_LABEL)} />
          {!failed && view.text && <Output label="Результат" text={view.text} />}
        </>
      )
  }
}

/**
 * Input fields of the SDK's own tools (sdk-tools.d.ts), in words. A field not
 * listed keeps its own name, set in monospace: it is a name, not a word.
 */
const INPUT_LABEL: Record<string, string> = {
  command: 'Команда',
  description: 'Описание',
  file_path: 'Файл',
  notebook_path: 'Блокнот',
  path: 'Где',
  pattern: 'Шаблон',
  glob: 'Маска',
  url: 'Адрес',
  query: 'Запрос',
  prompt: 'Задание',
  content: 'Содержимое',
  old_string: 'Было',
  new_string: 'Стало',
  replace_all: 'Заменить все',
  offset: 'С строки',
  limit: 'Строк',
  timeout: 'Предел времени',
  run_in_background: 'В фоне',
  subagent_type: 'Тип агента',
  todos: 'Задачи',
  plan: 'План',
  task_id: 'Задача',
  shell_id: 'Оболочка'
}

interface ArgRow {
  key: string
  /** Shown as a word, not as the raw field name. */
  label?: string
  value: string
}

function argRows(input: Record<string, unknown>, labels: Record<string, string> = {}): ArgRow[] {
  return Object.entries(input).map(([key, value]) => {
    const label = labels[key]
    return {
      key,
      ...(label ? { label } : {}),
      value: typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
    }
  })
}

/** The call's arguments as a key–value table. */
function Args({ args }: { args: ArgRow[] }): JSX.Element | null {
  if (args.length === 0) return null
  return (
    <table className="tool-args" data-testid="tool-args">
      <tbody>
        {args.map((arg) => (
          <tr key={arg.key}>
            <th scope="row" className={arg.label ? undefined : 'tool-mono'}>
              {arg.label ?? arg.key}
            </th>
            <td className="tool-mono tool-wrap">{arg.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function changed(added: number, removed: number): string {
  return `добавлено ${added}, удалено ${removed}`
}

function found(view: Extract<ToolView, { type: 'search' }>): string {
  const n = view.count
  if (view.unit === 'files') return `${n} ${plural(n, 'файл', 'файла', 'файлов')}`
  if (view.unit === 'matches') return `${n} ${plural(n, 'совпадение', 'совпадения', 'совпадений')}`
  return lines(n)
}

/** Label and value pairs, in two aligned columns. */
function Facts({ children }: { children: ReactNode }): JSX.Element | null {
  return <dl className="tool-facts">{children}</dl>
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function PathFact({ path }: { path: string }): JSX.Element | null {
  if (!path) return null
  return (
    <Fact label="Файл">
      <span className="tool-mono tool-wrap">
        <PathText path={path} />
      </span>
    </Fact>
  )
}

/** How long the call took, measured by the ribbon; nothing for a call too quick to matter. */
function Duration({ item }: { item: ToolCardItem }): JSX.Element | null {
  const ms = item.durationMs
  if (ms === undefined || ms < 100) return null
  return <Fact label="Время">{seconds(ms)}</Fact>
}

/**
 * A block of output, at most 320px tall with its own scroll. «Показать всё»
 * lifts the limit; it shows what the card kept, the card never asks for more.
 */
function Output({ label, text, testId }: { label: string; text: string; testId?: string }): JSX.Element {
  const pre = useRef<HTMLPreElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  const [whole, setWhole] = useState(false)

  // Re-measured on resize too: a narrower window wraps more and overflows sooner.
  useLayoutEffect(() => {
    const el = pre.current
    if (!el) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  return (
    <section className="tool-output">
      <header className="tool-output-head">
        <span>{label}</span>
        {(overflows || whole) && (
          <button type="button" className="tool-output-more" title={whole ? 'Свернуть вывод' : 'Показать весь вывод'} onClick={() => setWhole((w) => !w)}>
            {whole ? 'Свернуть' : 'Показать всё'}
          </button>
        )}
      </header>
      <pre ref={pre} className={`tool-pre${whole ? ' is-whole' : ''}`} data-testid={testId}>
        <OutputText text={text} />
      </pre>
    </section>
  )
}

/** Lines of a file with their numbers, as the file has them. */
function Numbered({ label, start, rows }: { label: string; start: number; rows: string[] }): JSX.Element {
  return (
    <section className="tool-output">
      <header className="tool-output-head">
        <span>{label}</span>
      </header>
      <div className="tool-pre tool-numbered">
        {rows.map((row, i) => (
          <div key={i} className="tool-numbered-line">
            <span className="diff-no">{start + i}</span>
            <span className="diff-text">{row}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
