import type { RelayMethod } from '../shared/relayProtocol'
import type { ExtraMethod } from './daemon'
import type { Run } from './supervisor'

export interface MethodDeps {
  run: Run
  version: string
  claudePath: () => string | null
  home: string
}

/** The daemon's methods beyond sessions: files, history, account, host (task 13). */
export function relayMethods(_deps: MethodDeps): Partial<Record<RelayMethod, ExtraMethod>> {
  return {}
}
