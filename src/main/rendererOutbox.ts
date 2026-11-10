import { CHANNELS } from '../shared/channels'
import type { RibbonEvent } from '../shared/types'
import { RibbonBatcher } from './ribbonBatcher'

/**
 * The one way a message reaches the window.
 *
 * Ribbon changes wait up to a frame to be sent together; status, panel and tab
 * messages used to go out at once, so "idle" could arrive before the last
 * chunk of text. Anything else sent here first lets the waiting ribbon go, in
 * the order the changes were made, so the window never hears the end of a
 * turn before its last words.
 */
export class RendererOutbox {
  private readonly batcher: RibbonBatcher

  constructor(
    private readonly sendNow: (channel: string, payload: unknown) => void,
    frameMs = 16
  ) {
    this.batcher = new RibbonBatcher(
      (event) => this.sendNow(CHANNELS.ribbonChanged, event),
      frameMs
    )
  }

  ribbon(event: RibbonEvent): void {
    this.batcher.push(event)
  }

  send(channel: string, payload: unknown): void {
    this.batcher.flush()
    this.sendNow(channel, payload)
  }

  flush(): void {
    this.batcher.flush()
  }
}
