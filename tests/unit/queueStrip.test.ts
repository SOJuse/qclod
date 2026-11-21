import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { QueueStrip } from '../../src/renderer/components/QueueStrip'
import type { QueuedMessage } from '../../src/shared/types'

const msg = (patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q1',
  text: 'и потом закоммить',
  attachments: 0,
  state: 'queued',
  canSendNow: true,
  ...patch
})

const render = (queue: QueuedMessage[]): string =>
  renderToStaticMarkup(
    createElement(QueueStrip, { queue, onSendNow: () => {}, onCancel: () => {}, onEdit: () => {} })
  )

describe('QueueStrip', () => {
  test('three buttons with their ids and titles', () => {
    const html = render([msg()])
    expect(html).toMatch(/data-testid="queue-send-now"[^>]*title="Отправить сейчас"|title="Отправить сейчас"[^>]*data-testid="queue-send-now"/)
    expect(html).toContain('data-testid="queue-edit"')
    expect(html).toContain('title="Изменить"')
    expect(html).toMatch(/data-testid="queue-cancel"[^>]*title="Убрать из очереди"|title="Убрать из очереди"[^>]*data-testid="queue-cancel"/)
  })

  test('no send-now button when it cannot go now', () => {
    const html = render([msg({ canSendNow: false })])
    expect(html).not.toContain('queue-send-now')
    expect(html).toContain('queue-edit')
    expect(html).toContain('queue-cancel')
  })

  test('cancelling: buttons disabled, spinner shown', () => {
    const html = render([msg({ state: 'cancelling' })])
    for (const id of ['queue-send-now', 'queue-edit', 'queue-cancel']) {
      const button = html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? ''
      expect(button).toContain('disabled')
    }
    expect(html).toContain('queue-spinner')
  })

  test('cancelling: the spinner says so to a screen reader', () => {
    const html = render([msg({ state: 'cancelling' })])
    const status = html.match(/<[a-z]+[^>]*role="status"[^>]*>/)?.[0] ?? ''
    expect(status).toContain('aria-label="Отменяю…"')
    expect(status).not.toContain('aria-hidden')
    expect(render([msg()])).not.toContain('role="status"')
  })

  test('captions for queued and waiting', () => {
    expect(render([msg()])).toContain('Дойдёт после текущего шага: «и потом закоммить»')
    expect(render([msg({ state: 'waiting' })])).toContain(
      'Отправится, когда агент запустится: «и потом закоммить»'
    )
  })

  test('buttons are not disabled while waiting', () => {
    expect(render([msg()])).not.toContain('disabled')
  })
})

describe('QueueStrip: поручение сабагенту (этап 4)', () => {
  test('при relay: true нет «Изменить», «Убрать» остаётся', () => {
    const html = render([msg({ relay: true })])
    expect(html).not.toContain('data-testid="queue-edit"')
    expect(html).toContain('data-testid="queue-cancel"')
    expect(render([msg()])).toContain('data-testid="queue-edit"')
  })
})
