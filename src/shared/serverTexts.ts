import type { ConnectStep, ServerConnState } from './types'

/** The connection checklist's five lines, in order (stage 6). */
export const CONNECT_STEP_TEXT: Record<ConnectStep['id'], string> = {
  ssh: 'Связь с сервером',
  auth: 'Вход',
  claude: 'Claude Code на сервере',
  relay: 'Посредник Qclod',
  login: 'Аккаунт Claude'
}

export const CONNECT_STEP_IDS: readonly ConnectStep['id'][] = ['ssh', 'auth', 'claude', 'relay', 'login']

/** The checklist before anything has run. */
export function pendingSteps(): ConnectStep[] {
  return CONNECT_STEP_IDS.map((id) => ({ id, state: 'pending', text: CONNECT_STEP_TEXT[id] }))
}

/** The chat header's word on the server's channel, and what a click on it does. */
export function connectionLabel(state: ServerConnState): { text: string; action?: 'retry' | 'connect' } {
  switch (state) {
    case 'online':
      return { text: 'на связи' }
    case 'reconnecting':
    case 'connecting':
      return { text: 'переподключение…' }
    case 'needsAuth':
      return { text: 'нужен пароль — Подключиться', action: 'connect' }
    default:
      return { text: 'нет связи — Повторить', action: 'retry' }
  }
}

export const OFFLINE_STRIP_TEXT = 'Сервер не на связи. Сообщения уйдут, когда он вернётся.'
