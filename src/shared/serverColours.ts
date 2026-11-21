import type { ServerColour } from './types'

/** The six server colours, in the order of the circles in Settings (stage 6, task 22). */
export const SERVER_COLOUR_LIST: readonly ServerColour[] = Object.freeze([
  'blue',
  'violet',
  'green',
  'amber',
  'rose',
  'cyan'
])

export function isServerColour(value: unknown): value is ServerColour {
  return typeof value === 'string' && (SERVER_COLOUR_LIST as readonly string[]).includes(value)
}
