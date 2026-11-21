import { REAL_AGENT_REFUSED, driverChoice } from '../agent/createDriver'
import { importEsm } from '../esm'
import { locateAgent } from '../setup/findAgent'
import type { QueryLike } from './oneShot'

/**
 * The `query()` «Собрать мои шаблоны» asks. A release build has the SDK only.
 * A test build (buildFlags.d.ts) takes fakeOneShot from the fixture QCLOD_FAKE_SDK
 * names, with the script in QCLOD_FAKE_ONESHOT, and otherwise refuses — as
 * every session of a test build does (createDriver.ts).
 */
export async function harvestQuery(): Promise<QueryLike> {
  if (__QCLOD_TEST_SEAMS__) {
    const choice = driverChoice(true, process.env)
    if (choice === 'refuse') throw new Error(REAL_AGENT_REFUSED)
    const fakePath = process.env['QCLOD_FAKE_SDK']
    if (choice === 'fake' && fakePath) {
      const { pathToFileURL } = await import('node:url')
      const module = (await import(pathToFileURL(fakePath).href)) as {
        fakeOneShot: (script: unknown) => QueryLike
      }
      return module.fakeOneShot(JSON.parse(process.env['QCLOD_FAKE_ONESHOT'] ?? '{}'))
    }
  }
  const { query } = await importEsm<{ query: QueryLike }>('@anthropic-ai/claude-agent-sdk')
  return query
}

/** The owner's Claude Code, as their chats start it; a test build with the fixture needs none. */
export function harvestExecutable(agentPath: string): string {
  if (__QCLOD_TEST_SEAMS__ && driverChoice(true, process.env) === 'fake') return 'claude'
  return locateAgent(agentPath, process.env)
}
