import { beforeEach, describe, expect, test } from 'vitest'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import { loadUi, serializeUi } from '../../src/renderer/state/uiPersist'

const initial = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState(initial, true)
})

describe('useAppStore: слой «Агенты»', () => {
  test('openAgents ставит kind agents с agentId и заменяет слой git', () => {
    const store = useAppStore.getState()
    store.setPaneLayer('t', { kind: 'git' })
    store.openAgents('t', 'card-1')
    expect(useAppStore.getState().layerByTab['t']).toEqual({ kind: 'agents', agentId: 'card-1' })
    useAppStore.getState().openAgents('t')
    expect(useAppStore.getState().layerByTab['t']).toEqual({ kind: 'agents' })
    useAppStore.getState().openAgents('t', null)
    expect(useAppStore.getState().layerByTab['t']).toEqual({ kind: 'agents' })
  })

  test('closeAgents даёт null и не трогает другие панели', () => {
    const store = useAppStore.getState()
    store.openAgents('t')
    store.openAgents('u', 'c')
    useAppStore.getState().closeAgents('t')
    expect(useAppStore.getState().layerByTab['t']).toBeNull()
    expect(useAppStore.getState().layerByTab['u']).toEqual({ kind: 'agents', agentId: 'c' })
  })

  test('agentsView по умолчанию graph; setAgentsView меняет', () => {
    expect(useAppStore.getState().agentsView).toBe('graph')
    useAppStore.getState().setAgentsView('timeline')
    expect(useAppStore.getState().agentsView).toBe('timeline')
  })

  test('agentsView переживает uiPersist (sessionStorage), graph не пишется', () => {
    const state = { draftByTab: {}, attachmentsByTab: {}, agentsView: 'timeline' as const }
    const text = serializeUi(state)
    expect(loadUi({ getItem: () => text }).agentsView).toBe('timeline')
    const graph = serializeUi({ ...state, agentsView: 'graph' })
    expect(JSON.parse(graph)).toEqual({ draftByTab: {}, attachmentsByTab: {} })
    expect(loadUi({ getItem: () => JSON.stringify({ agentsView: 'что-то' }) }).agentsView).toBeUndefined()
  })

  test('agentDrafts по ключу tabId:cardId; пустой текст убирает ключ', () => {
    useAppStore.getState().setAgentDraft('t:c', 'недописано')
    expect(useAppStore.getState().agentDrafts).toEqual({ 't:c': 'недописано' })
    useAppStore.getState().setAgentDraft('t:c', '')
    expect(useAppStore.getState().agentDrafts).toEqual({})
  })
})
