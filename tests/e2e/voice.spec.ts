import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VoiceModelId } from '../../src/shared/voice'
import { launchQclod } from './helpers/launch'
import {
  modelFiles,
  seedVoiceModel,
  startModelServer,
  writeDownloadManifest,
  writeSpeechWav
} from './helpers/voice'

// Этап 5, задача 12: voice in the window, on the fake engine and Chromium's fake microphone.

const SCRIPT = ['Попроси клода проверить тесты.', 'Потом сделай гит пуш.']
const TWO_PHRASES = [
  { toneMs: 1200, silenceMs: 1000 },
  { toneMs: 1200, silenceMs: 1500 }
]
const ONE_PHRASE = [{ toneMs: 1200, silenceMs: 1500 }]

interface Run {
  app: ElectronApplication
  win: Page
  dir: string
  close(): Promise<void>
}

/** Each scenario its own profile (and its own folder for the WAV and the manifest). */
async function start(
  opts: {
    seed?: VoiceModelId
    manifest?: (dir: string) => string
    speech?: string[]
    wav?: Array<{ toneMs: number; silenceMs: number }>
    env?: Record<string, string>
    script?: unknown
  } = {}
): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-e2e-voice-'))
  const profile = join(dir, 'profile')
  const env: Record<string, string> = {
    QCLOD_USER_DATA: profile,
    QCLOD_FAKE_SHELL: '1',
    // Never the machine's own nvidia-smi.
    QCLOD_FAKE_NVIDIA: 'none',
    ...opts.env
  }
  if (opts.seed) env['QCLOD_FAKE_VOICE_MANIFEST'] = seedVoiceModel(profile, opts.seed).manifestPath
  if (opts.manifest) env['QCLOD_FAKE_VOICE_MANIFEST'] = opts.manifest(dir)
  if (opts.speech) env['QCLOD_FAKE_SPEECH'] = JSON.stringify(opts.speech)
  if (opts.wav) env['QCLOD_FAKE_MIC'] = writeSpeechWav(dir, opts.wav)
  const { app, win } = await launchQclod({ env, ...(opts.script !== undefined ? { script: opts.script } : {}) })
  return {
    app,
    win,
    dir,
    close: async () => {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

const mic = (win: Page) => win.locator('[data-testid="composer-mic"]')
const input = (win: Page) => win.locator('[data-testid="composer-input"]')
const card = (win: Page, id: VoiceModelId) => win.locator(`[data-testid="voice-model-${id}"]`)

async function openVoiceSettings(win: Page): Promise<void> {
  await win.locator('[data-testid="open-settings"]').click()
  await win.locator('[data-testid="settings-nav-voice"]').click()
  await expect(win.locator('[data-testid="voice-section"]')).toBeVisible()
}

test('без модели: меню предлагает скачать; Win+H остаётся', async () => {
  const run = await start()
  try {
    const { win, app } = run
    await expect(mic(win)).toHaveAttribute('data-state', 'download')
    await expect(mic(win)).toHaveAttribute('title', 'Голосовой ввод: нужна модель (232 МБ)')
    await mic(win).click()
    const menu = win.locator('[data-testid="voice-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Скачать модель голоса (232 МБ)',
      'Диктовка Windows (Win+H)',
      'Настройки голоса'
    ])
    await win.locator('[data-testid="voice-menu-windows"]').click()
    await expect(menu).toHaveCount(0)
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __qclodVoiceStarts?: number }).__qclodVoiceStarts ?? 0))
      .toBe(1)
    await expect(input(win)).toBeFocused()

    // «Настройки голоса» opens «Голос».
    await mic(win).click()
    await win.locator('[data-testid="voice-menu-settings"]').click()
    await expect(win.locator('[data-testid="voice-section"]')).toBeVisible()
  } finally {
    await run.close()
  }
})

test('скачивание в «Голос»: прогресс, «Готова», «Использовать», «Удалить»', async () => {
  const files = modelFiles('parakeet-v3', 64 * 1024)
  const server = await startModelServer(files, { chunkMs: 40 })
  const run = await start({
    manifest: (dir) => writeDownloadManifest(dir, 'parakeet-v3', files, { primary: server.url, mirror: server.mirror })
  })
  try {
    const { win } = run
    await openVoiceSettings(win)
    const parakeet = card(win, 'parakeet-v3')
    await expect(parakeet.locator('[data-testid="voice-model-status"]')).toHaveText('Не скачана')
    await parakeet.locator('[data-testid="voice-model-download"]').click()
    await expect(parakeet.locator('[data-testid="voice-model-status"]')).toContainText('Скачиваю: ')
    await expect(parakeet.locator('[data-testid="voice-model-cancel"]')).toBeVisible()
    await expect(parakeet.locator('[data-testid="voice-model-status"]')).toHaveText('Готова', { timeout: 20000 })

    await parakeet.locator('[data-testid="voice-model-use"]').click()
    await expect(parakeet.locator('[data-testid="voice-model-used"]')).toHaveText('Используется')
    await expect(card(win, 'gigaam-v3').locator('[data-testid="voice-model-used"]')).toHaveCount(0)

    const remove = parakeet.locator('[data-testid="voice-model-delete"]')
    await remove.click()
    await expect(remove).toHaveText('Точно удалить?')
    await remove.click()
    await expect(parakeet.locator('[data-testid="voice-model-status"]')).toHaveText('Не скачана')
  } finally {
    await run.close()
    await server.close()
  }
})

test('обрыв на середине: «Повторить» докачивает', async () => {
  const files = modelFiles('gigaam-v3', 64 * 1024)
  const server = await startModelServer(files, { dropAfterBytes: 20_000, chunkMs: 30 })
  const run = await start({
    // One address: the break is not covered by the mirror.
    manifest: (dir) => writeDownloadManifest(dir, 'gigaam-v3', files, { primary: server.url })
  })
  try {
    const { win } = run
    await openVoiceSettings(win)
    const giga = card(win, 'gigaam-v3')
    await giga.locator('[data-testid="voice-model-download"]').click()
    await expect(giga.locator('[data-testid="voice-model-status"]')).toHaveText(
      'Нет связи с сервером. Нажмите «Повторить» — скачивание продолжится с того же места.'
    )
    await giga.locator('[data-testid="voice-model-retry"]').click()
    await expect(giga.locator('[data-testid="voice-model-status"]')).toHaveText('Готова', { timeout: 20000 })
    const first = server.requests[0]!
    expect(first.range).toBeUndefined()
    // The second request of that file asks only for the rest.
    const ranges = server.requests.filter((r) => r.path === first.path).map((r) => r.range)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toBeUndefined()
    const resumedAt = Number(/^bytes=(\d+)-$/.exec(ranges[1] ?? '')?.[1] ?? 0)
    expect(resumedAt).toBeGreaterThan(0)
    expect(resumedAt).toBeLessThanOrEqual(20_000)
  } finally {
    await run.close()
    await server.close()
  }
})

test('битый файл на основном — берётся зеркало', async () => {
  const files = modelFiles('gigaam-v3', 8 * 1024)
  const server = await startModelServer(files, { corrupt: ['encoder.int8.onnx'] })
  const run = await start({
    manifest: (dir) => writeDownloadManifest(dir, 'gigaam-v3', files, { primary: server.url, mirror: server.mirror })
  })
  try {
    const { win } = run
    await openVoiceSettings(win)
    const giga = card(win, 'gigaam-v3')
    await giga.locator('[data-testid="voice-model-download"]').click()
    await expect(giga.locator('[data-testid="voice-model-status"]')).toHaveText('Готова', { timeout: 20000 })
    const paths = server.requests.map((r) => r.path)
    expect(paths).toContain('/p/encoder.int8.onnx')
    expect(paths).toContain('/m/encoder.int8.onnx')
    // The good files came from the primary alone.
    expect(paths).not.toContain('/m/decoder.onnx')
  } finally {
    await run.close()
    await server.close()
  }
})

test('Whisper без NVIDIA — «Скачать» неактивна, «Нужна видеокарта NVIDIA»', async () => {
  const run = await start()
  try {
    const { win } = run
    await openVoiceSettings(win)
    const whisper = card(win, 'whisper-turbo-cuda')
    await expect(whisper.locator('[data-testid="voice-model-download"]')).toBeDisabled()
    await expect(whisper.locator('[data-testid="voice-model-reason"]')).toHaveText('Нужна видеокарта NVIDIA')
  } finally {
    await run.close()
  }
})

test('кнопкой: серый текст, потом фразы в поле со словарём, ничего не отправлено', async () => {
  const run = await start({ seed: 'gigaam-v3', speech: SCRIPT, wav: TWO_PHRASES })
  try {
    const { win } = run
    await expect(mic(win)).toHaveAttribute('data-state', 'off')
    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'listening')
    await expect(win.locator('[data-testid="composer-voice-tentative"]')).toContainText('Попроси')
    await expect(input(win)).toHaveValue('Попроси Claude проверить тесты. Потом сделай git push.', { timeout: 15000 })
    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'off')
    await expect(win.locator('[data-testid="composer-voice-tentative"]')).toHaveCount(0)
    // G9: the text waits in the field; nothing went to the agent.
    await expect(win.locator('[data-testid="ribbon-user"]')).toHaveCount(0)
    await expect(input(win)).toHaveValue('Попроси Claude проверить тесты. Потом сделай git push.')
  } finally {
    await run.close()
  }
})

test('Ctrl+Пробел: удержание 2,5 с пишет, отпускание останавливает', async () => {
  const run = await start({ seed: 'gigaam-v3', speech: SCRIPT, wav: ONE_PHRASE })
  try {
    const { win } = run
    await input(win).click()
    await win.keyboard.down('Control')
    await win.keyboard.down('Space')
    await expect(mic(win)).toHaveAttribute('data-state', 'listening')
    await win.waitForTimeout(2500)
    await win.keyboard.up('Space')
    await win.keyboard.up('Control')
    await expect(mic(win)).toHaveAttribute('data-state', 'off')
    await expect(input(win)).toHaveValue('Попроси Claude проверить тесты.')
  } finally {
    await run.close()
  }
})

test('после стопа можно печатать и говорить снова', async () => {
  const run = await start({ seed: 'gigaam-v3', speech: ['Проверь тесты.'], wav: ONE_PHRASE })
  try {
    const { win } = run
    await mic(win).click()
    await expect(input(win)).toHaveValue('Проверь тесты.', { timeout: 15000 })
    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'off')

    await input(win).press('End')
    await win.keyboard.type(' и')
    await mic(win).click()
    await expect(input(win)).toHaveValue('Проверь тесты. и проверь тесты.', { timeout: 15000 })
    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'off')
  } finally {
    await run.close()
  }
})

test('Esc во время записи останавливает голос, агент не прерван', async () => {
  const run = await start({
    seed: 'gigaam-v3',
    speech: SCRIPT,
    wav: ONE_PHRASE,
    script: {
      steps: [],
      turns: [[{ kind: 'tool', name: 'Bash', input: { command: 'npm test' }, result: 'ok', pauseMs: 20000 }]]
    }
  })
  try {
    const { win } = run
    await input(win).click()
    await input(win).fill('поехали')
    await input(win).press('Enter')
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 15000 })

    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'listening')
    await input(win).press('Escape')
    await expect(mic(win)).toHaveAttribute('data-state', 'off')
    await win.waitForTimeout(500)
    await expect(win.locator('[data-testid="composer-stop"]')).toBeVisible()
  } finally {
    await run.close()
  }
})

test('запрет микрофона Windows — текст и кнопка параметров', async () => {
  const run = await start({ seed: 'gigaam-v3', speech: SCRIPT, wav: ONE_PHRASE, env: { QCLOD_FAKE_MIC_ACCESS: 'denied' } })
  try {
    const { win, app } = run
    const text =
      'Windows не даёт Qclod микрофон. Включите доступ: Параметры → Конфиденциальность и защита → Микрофон.'
    await mic(win).click()
    await expect(mic(win)).toHaveAttribute('data-state', 'unavailable')
    await expect(mic(win)).toHaveAttribute('title', text)

    await openVoiceSettings(win)
    await expect(win.locator('[data-testid="voice-mic-denied"]')).toContainText(text)
    await win.locator('[data-testid="voice-open-mic-settings"]').click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __qclodShellLog?: unknown[] }).__qclodShellLog ?? []))
      .toContainEqual({ action: 'mic-settings', path: 'ms-settings:privacy-microphone' })
  } finally {
    await run.close()
  }
})

test('падение движка: сообщение; следующее нажатие пишет снова', async () => {
  const run = await start({
    seed: 'gigaam-v3',
    speech: ['Проверь тесты.'],
    wav: ONE_PHRASE,
    env: { QCLOD_FAKE_SPEECH_CRASH: '1' }
  })
  try {
    const { win } = run
    await mic(win).click()
    await expect(input(win)).toHaveValue('Проверь тесты.', { timeout: 15000 })
    await expect(mic(win)).toHaveAttribute('data-state', 'unavailable')
    await expect(mic(win)).toHaveAttribute('title', 'Голосовой движок упал. Нажмите микрофон, чтобы запустить его снова.')

    await mic(win).click()
    await expect(mic(win)).not.toHaveAttribute('data-state', 'unavailable')
    await expect(input(win)).toHaveValue('Проверь тесты. Проверь тесты.', { timeout: 15000 })
  } finally {
    await run.close()
  }
})
