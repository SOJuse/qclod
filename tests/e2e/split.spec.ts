import { test, expect, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchQclod } from './helpers/launch'

/** Wide enough for four panes at --pane-min-w with room to move a splitter. */
const SIZE = { width: 1900, height: 900 }

const panesOf = (win: Page): Locator => win.locator('[data-testid="split-pane"]')
const order = (win: Page): Promise<string[]> =>
  panesOf(win).evaluateAll((els) => els.map((el) => el.getAttribute('data-pane') ?? ''))
const widths = (win: Page): Promise<number[]> =>
  panesOf(win).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))

/** Drags a sidebar row onto a pane, `x` across it (0 = left edge, 1 = right edge), above the panel button. */
async function dragRow(row: Locator, pane: Locator, x: number): Promise<void> {
  const box = await pane.boundingBox()
  if (!box) throw new Error('pane has no box')
  await row.dragTo(pane, { targetPosition: { x: Math.min(box.width - 4, Math.max(4, box.width * x)), y: box.height * 0.3 } })
}

test('чаты перетаскиваются из боковой панели в сплит: до четырёх, ширина мышью, всё переживает перезапуск', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qclod-split-dir-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-split-profile-'))
  const env = { QCLOD_USER_DATA: profile, QCLOD_PICK_FOLDER: folder }
  try {
    const first = await launchQclod({ env, size: SIZE })
    let saved: { order: string[]; widths: number[]; active: string }
    try {
      const { win } = first
      // Five chats; the newest is the one pane.
      const rows = win.locator('[data-testid="tab"]')
      for (let n = 2; n <= 5; n++) {
        await win.locator('[data-testid="tab-new"]').click()
        await expect(rows).toHaveCount(n, { timeout: 15000 })
      }
      // The panel takes room the four panes need.
      await win.locator('[data-testid="panel-close"]').click()
      const panes = panesOf(win)
      await expect(panes).toHaveCount(1)
      const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-tab') ?? ''))
      expect(ids).toHaveLength(5)
      const row = (id: string): Locator => win.locator(`[data-testid="tab"][data-tab="${id}"]`)
      const shown = (await order(win))[0]!
      const others = ids.filter((id) => id !== shown)

      // A chat let go on the pane's right edge opens beside it.
      await dragRow(row(others[0]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(2)
      // The zone frame is gone once the drop is in.
      await expect(win.locator('[data-testid="split-drop"]')).toHaveCount(0)
      await dragRow(row(others[1]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(3)
      await dragRow(row(others[2]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(4)
      const four = await order(win)
      expect(four).toEqual([shown, others[0], others[1], others[2]])

      // A fifth on an edge: still four, the same four.
      await dragRow(row(others[3]!), panes.last(), 0.97)
      await expect(panes).toHaveCount(4)
      expect(await order(win)).toEqual(four)

      // Review Focus 5. A chat already in a pane, let go on another pane's left
      // edge, moves there (E10): no second copy, no fifth pane.
      await dragRow(row(four[2]!), panes.first(), 0.03)
      await expect.poll(() => order(win)).toEqual([four[2], four[0], four[1], four[3]])
      // On its own pane: nothing.
      await dragRow(row(four[3]!), panes.nth(3), 0.5)
      await dragRow(row(four[3]!), panes.nth(3), 0.03)
      expect(await order(win)).toEqual([four[2], four[0], four[1], four[3]])
      // On another pane's middle: the two trade places.
      await dragRow(row(four[3]!), panes.nth(0), 0.5)
      await expect.poll(() => order(win)).toEqual([four[3], four[0], four[1], four[2]])
      await expect(panes).toHaveCount(4)

      // The splitter between the first two panes: an arrow key moves it by 16 px, a double click evens the row.
      const splitter = win.locator('[data-testid="pane-splitter"]').first()
      await expect(win.locator('[data-testid="pane-splitter"]')).toHaveCount(3)
      await expect(splitter).toHaveAttribute('role', 'separator')
      await expect(splitter).toHaveAttribute('aria-orientation', 'vertical')
      await expect(splitter).toHaveAttribute('aria-label', 'Ширина панелей')
      const even = await widths(win)
      await splitter.focus()
      await win.keyboard.press('ArrowLeft')
      await expect.poll(async () => Math.round(even[0]! - (await widths(win))[0]!)).toBe(16)
      await splitter.dblclick()
      await expect.poll(async () => Math.abs((await widths(win))[0]! - even[0]!) < 1).toBe(true)

      // Pulled right with the mouse.
      const start = await widths(win)
      const s = (await splitter.boundingBox())!
      await win.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
      await win.mouse.down()
      await win.mouse.move(s.x + s.width / 2 + 30, s.y + s.height / 2, { steps: 3 })
      await win.mouse.move(s.x + s.width / 2 + 60, s.y + s.height / 2, { steps: 3 })
      await win.mouse.up()
      await expect.poll(async () => (await widths(win))[0]! - start[0]!).toBeGreaterThan(50)
      const after = await widths(win)
      expect(Math.abs(after[0]! + after[1]! - start[0]! - start[1]!)).toBeLessThan(2)
      for (const w of after) expect(w).toBeGreaterThanOrEqual(319)

      // The third pane is made active by a click; it stays where it is (E1).
      await panes.nth(2).locator('[data-testid="composer-input"]').click()
      await expect(panes.nth(2)).toHaveClass(/is-active/)

      saved = { order: await order(win), widths: await widths(win), active: (await order(win))[2]! }
      // Main has written it all down.
      const file = join(profile, 'layout.json')
      await expect
        .poll(() => {
          if (!existsSync(file)) return null
          const l = JSON.parse(readFileSync(file, 'utf8')) as { panes: string[]; paneWidths: number[]; active: string }
          return { panes: l.panes, active: l.active, equal: l.paneWidths.every((w) => Math.abs(w - 0.25) < 1e-6) }
        })
        .toEqual({ panes: saved.order, active: saved.active, equal: false })
    } finally {
      await first.app.close()
    }

    // E7: the same profile again.
    const second = await launchQclod({ env, size: SIZE })
    try {
      const { win } = second
      await expect(panesOf(win)).toHaveCount(4, { timeout: 15000 })
      expect(await order(win)).toEqual(saved.order)
      await expect(panesOf(win).nth(2)).toHaveClass(/is-active/)
      await expect
        .poll(async () => (await widths(win)).map((w, i) => Math.abs(w - saved.widths[i]!) <= 2))
        .toEqual([true, true, true, true])
    } finally {
      await second.app.close()
    }
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
  }
})
