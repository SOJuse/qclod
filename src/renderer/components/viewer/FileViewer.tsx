import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ViewerFile } from '../../../shared/viewerFile'
import { bytes, lines as linesWord } from '../../../shared/format'
import { highlight } from '../../markdown/highlight'
import { languageOf } from './language'
import './FileViewer.css'

/** Whose file: this machine's, or (этап 6) a server's. */
export type FileSource = { kind: 'local' } | { kind: 'remote'; hostId: string }

/** A file with more lines than this shows its head: the window stays quick. */
const MAX_LINES = 20_000

/** The one place the viewer reads a file from; stage 6 swaps its reader here. */
export function readViewerFile(tabId: string, source: FileSource, path: string): Promise<ViewerFile> {
  if (source.kind !== 'local') return Promise.resolve({ kind: 'error', message: 'Серверные файлы пока не открываются.' })
  return window.qclod.viewerRead(tabId, path)
}

/**
 * A text file, read-only: syntax colour, line numbers, one line marked and
 * scrolled to (`line`). No input of any kind. `closeLabel` adds a button of its
 * own (the Git layer's «Назад к изменениям»); a layer over the ribbon has its own «Закрыть».
 */
export function FileViewer({
  tabId,
  source,
  path,
  line,
  onClose,
  closeLabel
}: {
  tabId: string
  source: FileSource
  path: string
  line?: number | undefined
  onClose: () => void
  closeLabel?: string
}): JSX.Element {
  const [file, setFile] = useState<ViewerFile | null>(null)
  const hostId = source.kind === 'remote' ? source.hostId : ''
  useEffect(() => {
    let live = true
    setFile(null)
    readViewerFile(tabId, source, path)
      .then((f) => {
        if (live) setFile(f)
      })
      .catch(() => {
        if (live) setFile({ kind: 'error', message: 'Не удалось прочитать файл.' })
      })
    return () => {
      live = false
    }
  }, [tabId, source.kind, hostId, path])

  return (
    <div className="file-viewer" data-testid="file-viewer">
      {closeLabel && (
        <button type="button" className="file-viewer-back" data-testid="file-viewer-back" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden="true" />
          <span>{closeLabel}</span>
        </button>
      )}
      <FileBody file={file} path={path} line={line} />
    </div>
  )
}

export function FileBody({
  file,
  path,
  line
}: {
  file: ViewerFile | null
  path: string
  line?: number | undefined
}): JSX.Element {
  const language = useMemo(() => languageOf(path), [path])
  const total = useMemo(() => {
    if (file?.kind !== 'text') return 0
    return file.text.split('\n').length - (file.text.endsWith('\n') ? 1 : 0)
  }, [file])
  const rows = useMemo(() => {
    if (file?.kind !== 'text') return []
    const all = file.text.split('\n')
    if (all[all.length - 1] === '') all.pop()
    return highlight(all.slice(0, MAX_LINES).join('\n'), language)
  }, [file, language])
  const marked = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    marked.current?.scrollIntoView?.({ block: 'center' })
  }, [file, line])

  if (file === null) return <p className="file-viewer-note">Загружаю…</p>
  if (file.kind === 'missing') return <p className="file-viewer-note">Файла больше нет.</p>
  if (file.kind === 'error') {
    return (
      <p className="file-viewer-note" role="alert">
        {file.message}
      </p>
    )
  }
  if (file.kind === 'binary') return <p className="file-viewer-note">Двоичный файл — текст не показывается.</p>
  return (
    <div className="file-viewer-code" data-testid="file-viewer-code">
      {rows.map((tokens, i) => {
        const target = line === i + 1
        return (
          <div
            key={i}
            ref={target ? marked : undefined}
            className={`file-viewer-line${target ? ' is-target' : ''}`}
            data-line={i + 1}
            {...(target ? { 'data-testid': 'file-viewer-target' } : {})}
          >
            <span className="diff-no">{i + 1}</span>
            <span className="file-viewer-text">
              {tokens.map((t, k) => (
                <span key={k} className={`tok-${t.kind}`}>
                  {t.text}
                </span>
              ))}
            </span>
          </div>
        )
      })}
      {total > MAX_LINES && <p className="file-viewer-note">и ещё {linesWord(total - MAX_LINES)}</p>}
      {file.truncated && (
        <p className="file-viewer-note">
          Файл большой — показано начало ({bytes(file.text.length)} из {bytes(file.size)}).
        </p>
      )}
    </div>
  )
}
