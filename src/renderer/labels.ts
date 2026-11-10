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
  auto: 'автоматически',
  dontAsk: 'не спрашивать',
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
