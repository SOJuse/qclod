import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import type { EnvironmentReport, LoginProgress } from '../../shared/types'
import './SetupScreen.css'

interface Props {
  report: EnvironmentReport
  onRecheck: () => void
  onDone: () => void
  onOpenSettings: () => void
}

type StepState = 'done' | 'active' | 'todo' | 'blocked'

interface Action {
  testId: string
  label: string
  title: string
  run: () => void
}

interface StepView {
  state: StepState
  text: string
  textTestId?: string
  /** The button that moves this step on; shown as the screen's primary while the step is active. */
  main?: Action
  extra?: Action
}

/**
 * What a machine needs before Qclod is any use, and how to get there.
 *
 * Qclod drives the user's own Claude Code — their login, their settings, their
 * plugins — rather than bundling a second copy of it. That is the right trade
 * for someone who already works in the CLI, and the price is that a fresh
 * machine has nothing to drive. This screen pays that price out loud, as two
 * steps: put Claude Code on the machine, then log in once.
 */
export function SetupScreen({ report, onRecheck, onDone, onOpenSettings }: Props): JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const [installFailed, setInstallFailed] = useState(false)
  const cancelled = useRef(false)
  const [progress, setProgress] = useState<LoginProgress | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const tail = useRef<HTMLPreElement | null>(null)

  useEffect(() => window.qclod.onSetupOutput((line) => setLog((all) => [...all, line])), [])

  // The watch runs in the main process; this screen only shows where it is.
  useEffect(
    () =>
      window.qclod.onLoginProgress((p) => {
        setProgress(p)
        if (p === 'in') onRecheck()
      }),
    [onRecheck]
  )

  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight })
  }, [log, installing])

  async function install(): Promise<void> {
    cancelled.current = false
    setInstalling(true)
    setInstallFailed(false)
    setLog([])
    const ok = await window.qclod.installAgent()
    setInstalling(false)
    if (ok) onRecheck()
    else if (!cancelled.current) setInstallFailed(true)
  }

  function cancel(): void {
    cancelled.current = true
    void window.qclod.cancelInstall()
  }

  async function login(): Promise<void> {
    setLoginError(null)
    try {
      await window.qclod.login()
    } catch (err) {
      // Electron wraps the main side's message; only the reason is worth showing.
      const message = err instanceof Error ? err.message : String(err)
      setLoginError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setProgress(null)
    }
  }

  const settingsAction: Action = {
    testId: 'setup-open-settings',
    label: 'Открыть настройки',
    title: 'Указать путь к claude.exe в настройках',
    run: onOpenSettings
  }
  const installAction = (label: string): Action => ({
    testId: 'setup-install',
    label,
    title: 'Скачать и установить Claude Code',
    run: () => void install()
  })

  const agent = agentStep()
  const signIn = loginStep()
  // Nothing left for a step to do: «Начать работу» becomes the one primary button.
  const allDone = agent.state === 'done' && !signIn.main
  const showLog = log.length > 0
  // Once it worked, only the last line is worth keeping in view.
  const shownLog = installing || !report.agent.found ? log : log.slice(-1)

  function agentStep(): StepView {
    const { found, version, problem } = report.agent
    if (found) {
      return { state: 'done', text: version ? `Установлен, версия ${version}` : 'Установлен' }
    }
    if (installing) {
      return {
        state: 'active',
        text: 'Устанавливаю…',
        main: { testId: 'setup-cancel', label: 'Отменить', title: 'Остановить установку', run: cancel }
      }
    }
    if (installFailed) {
      return {
        state: 'blocked',
        text: 'Установить не получилось. Если Claude Code у вас уже стоит, укажите путь к claude.exe в настройках.',
        main: installAction('Попробовать снова'),
        extra: settingsAction
      }
    }
    if (problem) {
      return {
        state: 'blocked',
        text: problem,
        textTestId: 'setup-agent-problem',
        ...(report.installMethod
          ? { main: installAction('Установить'), extra: settingsAction }
          : { main: settingsAction })
      }
    }
    if (report.installMethod === null) {
      return {
        state: 'blocked',
        text: 'Нечем установить: нет ни winget, ни Node.js. Поставьте Claude Code вручную и укажите путь к claude.exe в настройках.',
        textTestId: 'setup-no-method',
        main: settingsAction
      }
    }
    return { state: 'active', text: 'Не установлен на этом компьютере.', main: installAction('Установить') }
  }

  function loginStep(): StepView {
    const out = 'Нужно войти один раз. Откроется окно, а в нём браузер.'
    const enter: Action = {
      testId: 'setup-login',
      label: 'Войти',
      title: 'Открыть окно входа в Claude Code',
      run: () => void login()
    }
    if (!report.agent.found) return { state: 'todo', text: out }
    if (report.auth === 'in' || progress === 'in') return { state: 'done', text: 'Вход выполнен.' }
    if (loginError) return { state: 'active', text: loginError, main: enter }
    if (progress === 'waiting') {
      return {
        state: 'active',
        text: 'Жду входа в открывшемся окне…',
        main: { ...enter, label: 'Открыть окно ещё раз' }
      }
    }
    if (progress === 'timeout') {
      return { state: 'active', text: 'Не дождался входа. Если вы уже вошли, нажмите «Проверить снова».', main: enter }
    }
    if (report.auth === 'unknown') {
      return {
        state: 'blocked',
        text: 'Не удалось проверить вход. Если Claude Code попросит войти, во вкладке появится кнопка «Войти».'
      }
    }
    return { state: 'active', text: out, main: enter }
  }

  const steps = [
    { id: 'agent', number: 1, name: 'Claude Code', view: agent, textTestId: undefined },
    { id: 'login', number: 2, name: 'Вход в аккаунт', view: signIn, textTestId: 'setup-login-state' }
  ] as const
  // The rail fills up to the step that is being worked on.
  const reached = agent.state === 'done'

  return (
    <div className="setup" data-testid="setup-screen">
      <div className="setup-card">
        <h1 className="setup-title">Подготовим Qclod к работе</h1>
        <p className="setup-lead">
          Qclod работает через Claude Code — вашу программу и ваш аккаунт. Нужно два шага.
        </p>

        <ol className="setup-steps">
          {steps.map(({ id, number, name, view, textTestId }) => {
            const primary = view.state !== 'done' && view.state !== 'todo'
            return (
              <li
                key={id}
                className="setup-step"
                data-testid={`setup-step-${id}`}
                data-state={view.state}
              >
                <div className="setup-track" aria-hidden="true">
                  <span className="setup-marker">
                    {view.state === 'done' ? (
                      <Check size={14} strokeWidth={2.5} />
                    ) : view.state === 'blocked' ? (
                      <CircleAlert size={15} strokeWidth={2} />
                    ) : (
                      number
                    )}
                  </span>
                  {id === 'agent' && (
                    <span className="setup-rail">
                      <span className={`setup-rail-fill${reached ? ' is-full' : ''}`} />
                    </span>
                  )}
                </div>
                <div className="setup-step-body">
                  <div className="setup-step-head">
                    <h2 className="setup-step-name">{name}</h2>
                    {view.state !== 'todo' && (view.main || view.extra) && (
                      <div className="setup-step-actions">
                        {view.extra && <SetupButton action={view.extra} />}
                        {view.main && <SetupButton action={view.main} primary={primary} />}
                      </div>
                    )}
                  </div>
                  <p
                    className="setup-step-text"
                    data-testid={view.textTestId ?? textTestId}
                    role={id === 'login' ? 'status' : undefined}
                  >
                    {view.text}
                  </p>
                  {id === 'agent' && showLog && (
                    <pre
                      className={`setup-log${installing ? ' is-live' : ''}`}
                      data-testid="setup-log"
                      ref={tail}
                    >
                      {shownLog.join('\n')}
                    </pre>
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        <div className="setup-actions">
          <SetupButton
            action={{
              testId: 'setup-recheck',
              label: 'Проверить снова',
              title: 'Проверить, что Claude Code на месте и вход выполнен',
              run: onRecheck
            }}
          />
          <SetupButton
            action={{ testId: 'setup-done', label: 'Начать работу', title: 'Перейти к работе', run: onDone }}
            primary={allDone}
            disabled={!report.agent.found}
          />
        </div>
      </div>
    </div>
  )
}

function SetupButton({
  action,
  primary = false,
  disabled = false
}: {
  action: Action
  primary?: boolean
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={`setup-button${primary ? ' is-primary' : ''}`}
      data-testid={action.testId}
      title={action.title}
      disabled={disabled}
      onClick={action.run}
    >
      {action.label}
    </button>
  )
}
