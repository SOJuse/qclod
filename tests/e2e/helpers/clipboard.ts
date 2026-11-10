import type { ElectronApplication, Page } from '@playwright/test'

// The suite never touches the system clipboard: it is the person's, and they
// may be using the machine while the tests run. Copies are caught inside the
// page, pastes are delivered to it as a paste event with the same data a real
// Ctrl+V of a screenshot carries.

/** From now on, what the page copies stays in the page instead of the clipboard. */
export async function catchCopies(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { __qclodCopied?: string }
    navigator.clipboard.writeText = async (text: string) => {
      w.__qclodCopied = text
    }
  })
}

/** The last text the page copied, after `catchCopies`. */
export async function copiedText(win: Page): Promise<string> {
  return win.evaluate(() => (window as unknown as { __qclodCopied?: string }).__qclodCopied ?? '')
}

/** A PNG of the given size, as a screenshot tool would leave it in the clipboard. */
export async function screenshotPng(app: ElectronApplication, width: number, height: number): Promise<string> {
  return app.evaluate(
    ({ nativeImage }, size) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(size.width * size.height * 4, 200), size)
        .toPNG()
        .toString('base64'),
    { width, height }
  )
}

/** Clicks the composer and pastes the picture into it, as Ctrl+V would. */
export async function pasteImage(win: Page, pngBase64: string): Promise<void> {
  const input = win.locator('[data-testid="composer-input"]')
  await input.click()
  await input.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, pngBase64)
}
