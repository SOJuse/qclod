import { useEffect, useRef, useState } from 'react'
import type { EnvironmentReport } from '../../shared/types'
import './SetupScreen.css'

interface Props {
  report: EnvironmentReport
  onRecheck: () => void
  onDone: () => void
}

const NODE_URL = 'https://nodejs.org/en/download'

/**
 * What a machine needs before Qclod is any use, and how to get there.
 *
 * Qclod drives the user's own Claude Code — their login, their settings, their
 * plugins — rather than bundling a second copy of it. That is the right trade
 * for someone who already works in the CLI, and the price is that a fresh
 * machine has nothing to drive. This screen pays that price out loud instead
 * of letting the first message fail with «не удалось найти claude».
 */
export function SetupScreen({ report, onRecheck, onDone }: Props): JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const tail = useRef<HTMLPreElement | null>(null)

  useEffect(() => window.qclod.onSetupOutput((line) => setLog((all) => [...all, line])), [])

  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight })
  }, [log])

  const canInstall = report.npm.found && !installing

  async function install(): Promise<void> {
    setInstalling(true)
    setLog([])
    const ok = await window.qclod.installAgent()
    setInstalling(false)
    if (ok) onRecheck()
  }

  return (
    <div className="setup" data-testid="setup-screen">
      <div className="setup-card">
        <h1 className="setup-title">Qclod</h1>
        <p className="setup-lead">
          Qclod — окно для Claude Code. Он запускает <b>ваш</b> Claude Code: ваш вход, ваши
          настройки, ваши плагины. Поэтому его нужно поставить один раз.
        </p>

        <ul className="setup-list">
          <Row
            label="Node.js"
            report={report.node}
            missing="Нужен, чтобы поставить Claude Code"
            action={
              report.node.found ? null : (
                <button type="button" onClick={() => void window.qclod.openExternal(NODE_URL)}>
                  Скачать
                </button>
              )
            }
          />
          <Row
            label="Claude Code"
            report={report.agent}
            missing="Сам агент — без него Qclod пустое окно"
            action={
              report.agent.found ? null : (
                <button
                  type="button"
                  data-testid="setup-install"
                  disabled={!canInstall}
                  onClick={() => void install()}
                >
                  {installing ? 'Ставлю…' : 'Установить'}
                </button>
              )
            }
          />
        </ul>

        {log.length > 0 && (
          <pre className="setup-log" data-testid="setup-log" ref={tail}>
            {log.join('\n')}
          </pre>
        )}

        {report.agent.found && (
          <p className="setup-lead setup-login">
            Осталось войти в аккаунт: откройте терминал и выполните вход — Qclod подхватит его.
          </p>
        )}

        <div className="setup-actions">
          {report.agent.found && (
            <button
              type="button"
              data-testid="setup-terminal"
              onClick={() => void window.qclod.openTerminal()}
            >
              Открыть терминал
            </button>
          )}
          <button type="button" data-testid="setup-recheck" onClick={onRecheck}>
            Проверить снова
          </button>
          <button
            type="button"
            className="setup-primary"
            data-testid="setup-done"
            disabled={!report.ready}
            onClick={onDone}
          >
            Начать работу
          </button>
        </div>

        {!report.ready && (
          <p className="setup-note">
            Если Claude Code уже стоит, но здесь его нет — укажите полный путь к нему в настройках
            Qclod.
          </p>
        )}
      </div>
    </div>
  )
}

function Row({
  label,
  report,
  missing,
  action
}: {
  label: string
  report: { found: boolean; version?: string; path?: string }
  missing: string
  action: JSX.Element | null
}): JSX.Element {
  return (
    <li className={`setup-row${report.found ? ' is-found' : ''}`} data-testid={`setup-${label}`}>
      <span className="setup-mark" aria-hidden>
        {report.found ? '✓' : '•'}
      </span>
      <span className="setup-name">{label}</span>
      <span className="setup-detail">
        {report.found ? (report.version ?? report.path ?? 'на месте') : missing}
      </span>
      {action}
    </li>
  )
}
