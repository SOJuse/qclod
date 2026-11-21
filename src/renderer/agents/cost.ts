import type { CostRates } from '../../shared/types'

/*
 * TEMPORARY copy for lane H2. `estimateCost` lives in src/shared/agentCost.ts
 * and `usd` in src/shared/format.ts — both from task 8 (lane L2), not on this
 * branch yet. At the merge (task 17) this file becomes:
 *   export { estimateCost } from '../../shared/agentCost'
 *   export { usd } from '../../shared/format'
 * Behaviour copied from task 8's brief, word for word.
 */

const FAMILY = /opus|sonnet|haiku|fable/

/** ≈ USD for a subagent's tokens: its model's rate, else its family's, else the session's average. */
export function estimateCost(tokens: number | undefined, model: string | undefined, rates: CostRates | null): number | null {
  if (!rates || tokens === undefined || !(tokens > 0)) return null
  if (model !== undefined) {
    const exact = rates.byModel[model]
    if (exact !== undefined) return tokens * exact
    const family = FAMILY.exec(model)?.[0]
    if (family) {
      const key = Object.keys(rates.byModel).find((k) => k.includes(family))
      if (key !== undefined) return tokens * rates.byModel[key]!
    }
  }
  return tokens * rates.average
}

/** «$0.0421», «$1.50» — as the session's cost in the panel. */
export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}
