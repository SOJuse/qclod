/**
 * A server chat's ribbon from its relay's journal (stage 6): the same
 * translator as a local conversation, fed the journal's records. The journal
 * keeps what the CLI does not echo — the messages sent (`sent`) — and the
 * relay's notices. Its process is still there: what runs stays running
 * (continueLive), unlike a past conversation's finishReplay.
 */
import { noticeText } from '../../core/autonomy'
import type { JournalRecord, RelayNotice } from '../../shared/relayProtocol'
import { RibbonBuilder } from '../../shared/ribbon'
import type { Attachment, PanelData, RibbonChange, UserInput } from '../../shared/types'
import type { SessionSeed } from '../agent/AgentSession'
import { PanelCollector } from '../agent/panelData'

/** The notices that are bad news, as AutonomyHost shows them. */
const ERROR_NOTICES: ReadonlySet<string> = new Set(['crashGaveUp', 'limitGaveUp', 'remoteGaveUp'])

/** A relay notice as the ribbon shows it, in this machine's time zone (сверка F5). */
export function relayNoticeLine(notice: RelayNotice): { text: string; tone: 'info' | 'error'; alert: boolean } {
  if (notice.kind === 'autonomy') {
    return {
      text: noticeText(notice.notice),
      tone: ERROR_NOTICES.has(notice.notice.kind) ? 'error' : 'info',
      alert: notice.alert
    }
  }
  return { text: notice.text, tone: notice.tone, alert: false }
}

export function isRelayNotice(value: unknown): value is RelayNotice {
  if (typeof value !== 'object' || value === null) return false
  const n = value as Record<string, unknown>
  if (n['kind'] === 'text') return typeof n['text'] === 'string' && (n['tone'] === 'info' || n['tone'] === 'error')
  return n['kind'] === 'autonomy' && typeof n['notice'] === 'object' && n['notice'] !== null
}

/** What a `sent` record carries: the input, who sent it, its uuid. */
export interface SentRecord {
  input: UserInput
  by: 'client' | 'autonomy'
  uuid?: string
}

export function readSent(d: unknown): SentRecord | null {
  if (typeof d !== 'object' || d === null) return null
  const r = d as Record<string, unknown>
  const input = r['input'] as Record<string, unknown> | undefined
  if (!input || typeof input['text'] !== 'string') return null
  const attachments = Array.isArray(input['attachments']) ? (input['attachments'] as Attachment[]) : []
  const opts = r['opts'] as Record<string, unknown> | undefined
  const uuid = opts && typeof opts['uuid'] === 'string' ? opts['uuid'] : undefined
  return {
    input: { text: input['text'], attachments },
    by: r['by'] === 'autonomy' ? 'autonomy' : 'client',
    ...(uuid ? { uuid } : {})
  }
}

/**
 * Feeds journal records into an existing builder and collector, replaying.
 * The ribbon changes and the panel patch, for the window.
 */
export function seedInto(
  builder: RibbonBuilder,
  collector: PanelCollector,
  records: JournalRecord[]
): { changes: RibbonChange[]; panel: Partial<PanelData> } {
  builder.beginReplay()
  const changes: RibbonChange[] = []
  const sdk: unknown[] = []
  for (const record of records) {
    if (record.k === 'sdk') {
      sdk.push(record.d)
      changes.push(...builder.apply(record.d))
    } else if (record.k === 'sent') {
      const sent = readSent(record.d)
      if (!sent) continue
      // The journal's record is the bubble; a CLI that echoes it gets its echo swallowed.
      changes.push(
        ...builder.addUser(sent.input.text, sent.input.attachments, sent.input.text, sent.uuid, sent.by === 'autonomy' ? { auto: true } : {})
      )
    } else if (record.k === 'notice' && isRelayNotice(record.d)) {
      const line = relayNoticeLine(record.d)
      changes.push(...builder.notice(line.text, line.tone))
    }
  }
  builder.continueLive()
  const panel = collector.seedFromTranscript(sdk)
  return { changes, panel }
}

/** A new ribbon and panel from a journal: the seed a server chat's session starts with. */
export function seedFromRelay(records: JournalRecord[]): SessionSeed {
  const builder = new RibbonBuilder({ replay: true })
  const collector = new PanelCollector()
  seedInto(builder, collector, records)
  return { builder, collector }
}
