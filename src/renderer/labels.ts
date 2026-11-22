import type { SessionStatus } from '../shared/types'

/** Names a person reads for the effort levels and permission modes; the panel and the settings share them. */
export const EFFORT_LABEL: Record<string, string> = {
  low: 'низкое — быстро',
  medium: 'среднее',
  high: 'высокое',
  xhigh: 'очень высокое',
  max: 'максимум — долго'
}

export const MODE_LABEL: Record<string, string> = {
  default: 'спрашивать',
  acceptEdits: 'принимать правки',
  plan: 'план',
  autoAllow: 'авто-да',
  auto: 'классификатор',
  dontAsk: 'только разрешённое',
  bypassPermissions: 'без проверок'
}

/** The same levels in one word, for the status line's button. */
export const EFFORT_SHORT: Record<string, string> = {
  low: 'низкое',
  medium: 'среднее',
  high: 'высокое',
  xhigh: 'очень высокое',
  max: 'максимум'
}

/** A chat's state in one word: the sidebar's row hint and the pane's header. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'запускается',
  busy: 'работает',
  waiting: 'ждёт ответа',
  idle: 'простаивает',
  stopped: 'не запущена',
  error: 'ошибка'
}
