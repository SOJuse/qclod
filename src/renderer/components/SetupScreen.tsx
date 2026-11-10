import { useEffect, useRef, useState } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import type { EnvironmentReport } from '../../shared/types'
import './SetupScreen.css'

interface Props {
  report: EnvironmentReport
  onRecheck: () => void
  onDone: () => void
}

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
          настройки, ваши плагины. Одна кнопка ниже скачает и поставит его, если его ещё нет.
        </p>

        <ul className="setup-list">
          <li
            className={`setup-row${report.agent.found ? ' is-found' : ''}`}
            data-testid="setup-agent"
          >
            <span className="setup-mark">
              {report.agent.found ? (
                <CircleCheck size={14} color="var(--status-ok)" role="img" aria-label="Найден" />
              ) : (
                <Circle size={14} color="var(--text-faint)" role="img" aria-label="Не найден" />
              )}
            </span>
            <span className="setup-name">Claude Code</span>
            <span className="setup-detail">
              {report.agent.found
                ? (report.agent.version ?? report.agent.path ?? 'на месте')
                : installing
                  ? 'ставлю…'
                  : 'не установлен'}
            </span>
            {!report.agent.found && (
              <button
                type="button"
                data-testid="setup-install"
                title="Установить Claude Code"
                disabled={installing || report.installMethod === null}
                onClick={() => void install()}
              >
                {installing ? 'Ставлю…' : 'Установить'}
              </button>
            )}
          </li>
        </ul>

        {!report.agent.found && report.installMethod === null && (
          <p className="setup-note" data-testid="setup-no-method">
            На этой машине нечем установить: нужен либо winget (он есть в Windows 10 и 11), либо
            Node.js. Либо поставьте Claude Code сами и укажите путь к нему в настройках Qclod.
          </p>
        )}

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
              title="Открыть терминал, чтобы войти в Claude Code"
              onClick={() => void window.qclod.openTerminal()}
            >
              Открыть терминал
            </button>
          )}
          <button type="button" data-testid="setup-recheck" title="Проверить, что нужное установлено" onClick={onRecheck}>
            Проверить снова
          </button>
          <button
            type="button"
            className="setup-primary"
            data-testid="setup-done"
            title="Перейти к работе"
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
