import type { RelayErrorCode } from '../shared/relayProtocol'

/** An error a request answers with: its code goes to the client as `res ok:false`. */
export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

export function badRequest(message: string): RelayError {
  return new RelayError('bad_request', message)
}
