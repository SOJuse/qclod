/**
 * What a permission question knows about the call it is asking about.
 *
 * The SDK hands `canUseTool` a third argument (`CanUseTool` in sdk.d.ts) with
 * the tool call's `toolUseID` — distinct for every call in one assistant
 * message — and an `AbortSignal` that fires when the question stops mattering.
 * Everything else in it is ignored here until something needs it.
 */
export interface ToolPermissionContext {
  /** The id of the tool_use block this question is about. */
  toolUseId?: string
  /** Fires when the SDK no longer waits for the answer. */
  signal?: AbortSignal
}

/**
 * Reads the SDK's options without trusting their shape: an id that is not a
 * non-empty string is no id at all, and anything that is not a real
 * AbortSignal is dropped rather than passed on as one.
 */
export function toPermissionContext(sdkOptions: unknown): ToolPermissionContext {
  if (typeof sdkOptions !== 'object' || sdkOptions === null) return {}
  const options = sdkOptions as Record<string, unknown>
  const id = options['toolUseID']
  const signal = options['signal']
  return {
    ...(typeof id === 'string' && id !== '' ? { toolUseId: id } : {}),
    ...(signal instanceof AbortSignal ? { signal } : {})
  }
}
