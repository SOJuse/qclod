import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, X } from 'lucide-react'
import type { FileSource, TabId, ViewerContent } from '../../../shared/types'
import { bytes } from '../../../shared/format'
import { highlight } from '../../markdown/highlight'
import { StateView, reasonOf } from '../../ui/StateView'
import '../../markdown/Markdown.css'
import './FileViewer.css'

/** Past this many characters the text is shown plain: thousands of token spans freeze the window. */
const HIGHLIGHT_MAX = 300_000

export const VIEWER_TEXTS = {
  readOnly: 'Только просмотр',
  truncated: 'Файл больше 2 МБ — показано начало',
  binary: (size: number) => `Это не текст (${bytes(size)})`,
  error: (message: string) => `Не удалось прочитать файл: ${message}`,
  download: 'Скачать и открыть',
  downloading: 'Скачиваю…',
  openFailed: (reason: string) => `Не удалось скачать: ${reason}`,
  openLocalFailed: (reason: string) => `Не удалось открыть: ${reason}`,
  openLocal: 'Открыть в программе',
  close: 'Закрыть',
  loading: 'Читаю файл…'
} as const

interface ViewProps {
  source: FileSource
  path: string
  /** From 1 (сверка F15): scrolled to and marked; outside the file — no mark. */
  line?: number | undefined
  /** null while it is being read. */
  content: ViewerContent | null
  /** «Скачать и открыть» / «Открыть в программе» under way: the button waits and says so. */
  opening?: boolean
  /** Why the last opening failed. */
  openError?: string | null
  onOpen(): void
  onClose(): void
  /** The close button's text: «Закрыть», or where it goes back to («Назад к изменениям»). */
  closeLabel?: string
}

/** The text's lines, highlighted when it is not too long for it. */
function TextLines({ text, language, line }: { text: string; language: string; line?: number | undefined }): JSX.Element {
  const lines = useMemo(
    () =>
      text.length <= HIGHLIGHT_MAX
        ? highlight(text, language)
        : text.split('\n').map((l) => [{ kind: 'plain' as const, text: l }]),
    [text, language]
  )
  return (
    <pre className="viewer-text" data-testid="viewer-text">
      {lines.map((tokens, i) => {
        const n = i + 1
        const marked = line === n
        return (
          <div key={n} className="viewer-line" data-line={n} {...(marked ? { 'data-line-mark': '' } : {})}>
            <code className="viewer-code">
              {tokens.length === 0 ? '\n' : tokens.map((t, j) => (
                <span key={j} className={`tok-${t.kind}`}>
                  {t.text}
                </span>
              ))}
            </code>
          </div>
        )
      })}
    </pre>
  )
}

/** What the viewer draws for a content: pure, for the tests and the container below. */
export function FileViewerView({
  source,
  path,
  line,
  content,
  opening = false,
  openError = null,
  onOpen,
  onClose,
  closeLabel = VIEWER_TEXTS.close
}: ViewProps): JSX.Element {
  const remote = source.kind === 'remote'
  return (
    <div className="file-viewer" data-testid="file-viewer" data-source={source.kind}>
      <header className="viewer-head">
        <span className="viewer-path" title={path}>
          {path}
        </span>
        <span className="viewer-badge" data-testid="viewer-readonly">
          {VIEWER_TEXTS.readOnly}
        </span>
        <button
          type="button"
          className="viewer-button"
          data-testid="viewer-open"
          disabled={opening}
          aria-busy={opening}
          onClick={onOpen}
        >
          {remote ? <Download size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
          <span>{opening && remote ? VIEWER_TEXTS.downloading : remote ? VIEWER_TEXTS.download : VIEWER_TEXTS.openLocal}</span>
        </button>
        <button type="button" className="viewer-button" data-testid="viewer-close" onClick={onClose}>
          <X size={14} aria-hidden="true" />
          <span>{closeLabel}</span>
        </button>
      </header>
      {openError !== null && (
        <p className="viewer-note viewer-error" role="alert" data-testid="viewer-open-error">
          {remote ? VIEWER_TEXTS.openFailed(openError) : VIEWER_TEXTS.openLocalFailed(openError)}
        </p>
      )}
      <div className="viewer-body">
        {content === null ? (
          <StateView kind="loading" title={VIEWER_TEXTS.loading} />
        ) : content.kind === 'error' ? (
          <p className="viewer-note viewer-error" role="alert" data-testid="viewer-error">
            {VIEWER_TEXTS.error(content.message)}
          </p>
        ) : content.kind === 'binary' ? (
          <p className="viewer-note" data-testid="viewer-binary">
            {VIEWER_TEXTS.binary(content.size)}
          </p>
        ) : content.kind === 'image' ? (
          <img className="viewer-image" data-testid="viewer-image" src={content.dataUrl} alt={path} />
        ) : (
          <>
            {content.truncated && (
              <p className="viewer-note" data-testid="viewer-truncated">
                {VIEWER_TEXTS.truncated}
              </p>
            )}
            <TextLines text={content.text} language={content.language} line={line} />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A file, read-only (A10), from this machine or the chat's server: opened as
 * the pane's layer (`setPaneLayer(tabId, {kind:'file', path, line})`, сверка
 * F9). Main decides whether the tab may read it (viewerRead).
 */
export function FileViewer(props: {
  source: FileSource
  path: string
  line?: number | undefined
  onClose(): void
  /** The chat it is opened from: main checks the path against it. */
  tabId: TabId
  closeLabel?: string
}): JSX.Element {
  const { source, path, line, onClose, tabId, closeLabel } = props
  const [content, setContent] = useState<ViewerContent | null>(null)
  const self = useRef<HTMLDivElement | null>(null)
  const sourceKey = source.kind === 'remote' ? `remote:${source.hostId}` : 'local'

  useEffect(() => {
    let live = true
    setContent(null)
    window.qclod
      .readForViewer(source, tabId, path)
      .then((c) => live && setContent(c))
      .catch((e: unknown) => live && setContent({ kind: 'error', message: reasonOf(e) }))
    return () => {
      live = false
    }
    // source is compared by its key: a new object for the same place reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, tabId, path])

  // To the marked line once the text is there.
  useEffect(() => {
    if (content?.kind !== 'text' || line === undefined) return
    self.current?.querySelector('[data-line-mark]')?.scrollIntoView({ block: 'center' })
  }, [content, line])

  /** One opening at a time: a second click while a file is coming down does nothing. */
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const busy = useRef(false)
  const onOpen = (): void => {
    if (busy.current) return
    busy.current = true
    setOpening(true)
    setOpenError(null)
    const call: Promise<unknown> =
      source.kind === 'remote' ? window.qclod.downloadAndOpen(tabId, path) : window.qclod.openPath(tabId, path)
    call
      .then(
        (result) => setOpenError(result === null ? 'файл не открылся' : null),
        (err: unknown) => setOpenError(reasonOf(err))
      )
      .finally(() => {
        busy.current = false
        setOpening(false)
      })
  }

  return (
    <div ref={self} className="file-viewer-host">
      <FileViewerView
        source={source}
        path={path}
        line={line}
        content={content}
        opening={opening}
        openError={openError}
        onOpen={onOpen}
        onClose={onClose}
        {...(closeLabel !== undefined ? { closeLabel } : {})}
      />

    </div>
  )
}
