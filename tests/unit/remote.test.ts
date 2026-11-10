import { describe, expect, test } from 'vitest'
import {
  REMOTE_BLOCK_TEXT,
  availabilityFrom,
  explainRemoteError,
  remoteFromMessage,
  safeRemoteUrl
} from '../../src/shared/remote'
import type { RemoteInfo } from '../../src/shared/types'

function bridge(state: string, detail?: string): unknown {
  return {
    type: 'system',
    subtype: 'bridge_state',
    state,
    detail: detail ?? null,
    ...(state === 'failed' ? { failure_kind: 'terminal' } : {}),
    bridge_epoch: 1,
    uuid: 'u',
    session_id: 's'
  }
}

describe('remoteFromMessage', () => {
  const on: RemoteInfo = { state: 'on', url: 'https://claude.ai/code/session_1' }
  test('connected и ready — на связи, ссылка сохраняется', () => {
    expect(remoteFromMessage(bridge('connected'), { state: 'connecting' })).toMatchObject({ state: 'on' })
    expect(remoteFromMessage(bridge('ready'), on)).toBeNull() // ничего не меняет
  })
  test('failed — нет связи, причина с подробностью', () => {
    expect(remoteFromMessage(bridge('failed', 'таймаут'), on)).toEqual({
      ...on,
      state: 'failed',
      problem: 'Связь с claude.ai потеряна. таймаут'
    })
  })
  test('policy_disabled — причина про организацию', () => {
    expect(remoteFromMessage(bridge('policy_disabled'), on)?.problem).toBe(
      'Remote Control отключён политикой вашей организации.'
    )
  })
  test('worker_shutting_down remote_control_disabled — выключен', () => {
    expect(
      remoteFromMessage({ type: 'system', subtype: 'worker_shutting_down', reason: 'remote_control_disabled' }, on)
    ).toEqual({ state: 'off' })
    expect(remoteFromMessage({ type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }, on)).toBeNull()
  })
  test('хвост моста после выключения не включает обратно', () => {
    expect(remoteFromMessage(bridge('connected'), { state: 'off' })).toBeNull()
  })
  test('неизвестное состояние и чужие сообщения — null', () => {
    expect(remoteFromMessage(bridge('warming'), on)).toBeNull()
    expect(remoteFromMessage({ type: 'assistant' }, on)).toBeNull()
  })
})
describe('availabilityFrom', () => {
  test('нет метода → sdk', () => expect(availabilityFrom(false, {})).toEqual({ available: false, reason: 'sdk' }))
  test('CLI сказал false → cli', () =>
    expect(availabilityFrom(true, { remote_control_available: false })).toEqual({ available: false, reason: 'cli' }))
  test('API-ключ без подписки → api_key', () =>
    expect(availabilityFrom(true, { account: { apiKeySource: 'ANTHROPIC_API_KEY' } })).toEqual({
      available: false,
      reason: 'api_key'
    }))
  test('Bedrock → provider', () =>
    expect(availabilityFrom(true, { account: { apiProvider: 'bedrock' } })).toEqual({
      available: false,
      reason: 'provider'
    }))
  test('подписка или старый CLI без поля → доступно', () => {
    expect(
      availabilityFrom(true, { account: { subscriptionType: 'max' }, remote_control_available: true })
    ).toEqual({ available: true })
    expect(availabilityFrom(true, undefined)).toEqual({ available: true })
  })
})
describe('safeRemoteUrl и explainRemoteError', () => {
  test('только https', () => {
    expect(safeRemoteUrl('https://claude.ai/code/session_1')).toBe('https://claude.ai/code/session_1')
    expect(safeRemoteUrl('http://claude.ai/x')).toBeNull()
    expect(safeRemoteUrl('javascript:alert(1)')).toBeNull()
    expect(safeRemoteUrl(42)).toBeNull()
  })
  test('ошибка входа — про подписку простыми словами', () => {
    expect(explainRemoteError(new Error('Remote Control requires a claude.ai subscription'))).toBe(
      REMOTE_BLOCK_TEXT.api_key
    )
    expect(explainRemoteError(new Error('boom'))).toBe('Не удалось включить Remote Control: boom')
  })
})
