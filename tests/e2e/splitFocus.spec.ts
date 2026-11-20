import { test, expect, _electron as electron, type Locator } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The accent (--accent, #5a8bff) as computed styles write it. */
const ACCENT_RGB = 'rgb(90, 139, 255)'

/** The frame E9 draws over the active pane: its ::after box-shadow. */
const frameOf = (pane: Locator): Promise<string> =>
  pane.evaluate((el) => getComputedStyle(el, '::after').boxShadow)

test('клик по правой панели делает её активной на месте, панели не переставляются', async () => {
  const other = mkdtempSync(join(tmpdir(), 'qclod-split-'))
  const profile = mkdtempSync(join(tmpdir(), 'qclod-splitfocus-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, QCLOD_USER_DATA: profile, QCLOD_PICK_FOLDER: other } as Record<string, string>
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="composer-input"]').first().waitFor({ timeout: 15000 })
    await win.locator('[data-testid="tab-new"]').click()
    await expect(win.locator('[data-testid="tab"]')).toHaveCount(2, { timeout: 15000 })
    await win.locator('[data-testid="toggle-split"]').click()
    const panes = win.locator('[data-testid="chat-pane"]')
    await expect(panes).toHaveCount(2)
    const frames = win.locator('[data-testid="split-pane"]')

    const left = panes.first()
    const right = panes.last()
    const rightTab = await right.getAttribute('data-tab')

    // Its title is part of the pane: a press there makes it active too, in place.
    await left.locator('[data-testid="pane-title"]').click()
    await expect(left).toHaveClass(/is-focused/)
    await expect(frames.first()).toHaveClass(/is-active/)
    expect(await frameOf(frames.first())).toContain(ACCENT_RGB)
    expect(await frameOf(frames.last())).not.toContain(ACCENT_RGB)

    await right.locator('[data-testid="composer-input"]').click()
    await expect(right).toHaveClass(/is-focused/)
    await expect(left).not.toHaveClass(/is-focused/)
    // E9: the accent frame moved with it; the other pane is not dimmed.
    await expect(frames.last()).toHaveClass(/is-active/)
    await expect.poll(() => frameOf(frames.last())).toContain(ACCENT_RGB)
    expect(await frameOf(frames.first())).not.toContain(ACCENT_RGB)
    await expect(left).toHaveCSS('opacity', '1')
    await win.keyboard.type('правый')
    await expect(right.locator('[data-testid="composer-input"]')).toHaveValue('правый')

    // Still the same pane on the right.
    await expect(panes.last()).toHaveAttribute('data-tab', rightTab ?? '')

    // One pane again: no frame, nothing to tell apart.
    await win.locator('[data-testid="toggle-split"]').click()
    await expect(panes).toHaveCount(1)
    expect(await frameOf(frames.first())).not.toContain(ACCENT_RGB)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
