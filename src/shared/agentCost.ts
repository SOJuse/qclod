import type { CostRates } from './types'

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * USD per token for each model, from the session's own `result.modelUsage`:
 * the CLI has already priced every token, subagents included, so no price
 * table is kept here to go stale with each new model. `modelUsage` is
 * cumulative, so the newest `result` is the one to take.
 *
 * A model's rate is its costUSD over all its tokens (input, output, cache
 * read, cache creation); `average` is the same over every model together.
 * A model with no tokens is skipped; nothing usable gives null.
 */
export function costRatesFrom(modelUsage: unknown): CostRates | null {
  if (!isObject(modelUsage)) return null
  const byModel: Record<string, number> = {}
  let cost = 0
  let tokens = 0
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!isObject(usage)) continue
    const used =
      count(usage['inputTokens']) +
      count(usage['outputTokens']) +
      count(usage['cacheReadInputTokens']) +
      count(usage['cacheCreationInputTokens'])
    const usd = count(usage['costUSD'])
    if (used === 0) continue
    byModel[model] = usd / used
    cost += usd
    tokens += used
  }
  if (tokens === 0) return null
  return { byModel, average: cost / tokens }
}

function familyOf(model: string): string | undefined {
  const name = model.toLowerCase()
  return FAMILIES.find((family) => name.includes(family))
}

/**
 * What an agent's tokens probably cost, in USD; null when there is nothing to
 * go on. The model is matched by exact key, then by family (`haiku` finds
 * `claude-haiku-5-5`), and otherwise the session's average rate is used.
 */
export function estimateCost(
  tokens: number | undefined,
  model: string | undefined,
  rates: CostRates | null
): number | null {
  if (!rates || typeof tokens !== 'number' || !(tokens > 0)) return null
  let rate: number | undefined
  if (model) {
    rate = rates.byModel[model]
    if (rate === undefined) {
      const family = familyOf(model)
      if (family) {
        const key = Object.keys(rates.byModel).find((k) => familyOf(k) === family)
        if (key !== undefined) rate = rates.byModel[key]
      }
    }
  }
  return tokens * (rate ?? rates.average)
}
