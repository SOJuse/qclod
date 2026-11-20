// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MicButton } from '../../src/renderer/components/composer/MicButton'
import type { VoiceButtonState, VoiceControls } from '../../src/shared/voice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const voice = (state: VoiceButtonState, patch: Partial<VoiceControls> = {}): VoiceControls => ({
  state,
  title: `голос: ${state}`,
  tentative: '',
  menu: [],
  press: vi.fn(),
  release: vi.fn(),
  caretMoved: vi.fn(),
  ...patch
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Draws the button and returns it. */
function draw(props: Parameters<typeof MicButton>[0]): HTMLButtonElement {
  act(() => root.render(createElement(MicButton, props)))
  const button = host.querySelector<HTMLButtonElement>('[data-testid="composer-mic"]')
  if (!button) throw new Error('кнопки нет')
  return button
}

/** A pointer event as the browser sends it; React listens to its type, whatever its class. */
function pointer(target: Element, type: 'pointerdown' | 'pointerup', button = 0): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }))
  })
}

describe('MicButton', () => {
  test('пять состояний дают свой data-state, title и aria-label — voice.title', () => {
    for (const state of ['off', 'listening', 'download', 'loading', 'unavailable'] as const) {
      const button = draw({ voice: voice(state), disabled: false, onFallback: () => undefined })
      expect(button.dataset['state']).toBe(state)
      expect(button.title).toBe(`голос: ${state}`)
      expect(button.getAttribute('aria-label')).toBe(`голос: ${state}`)
    }
  })

  test('listening — aria-pressed="true", остальные — false', () => {
    expect(draw({ voice: voice('listening'), disabled: false, onFallback: () => undefined }).getAttribute('aria-pressed')).toBe('true')
    expect(draw({ voice: voice('off'), disabled: false, onFallback: () => undefined }).getAttribute('aria-pressed')).toBe('false')
  })

  test('pointerdown зовёт press, pointerup — release; не главная кнопка мыши — ничего', () => {
    const controls = voice('off')
    const button = draw({ voice: controls, disabled: false, onFallback: () => undefined })
    pointer(button, 'pointerdown', 2)
    pointer(button, 'pointerup', 2)
    expect(controls.press).not.toHaveBeenCalled()
    expect(controls.release).not.toHaveBeenCalled()
    pointer(button, 'pointerdown')
    expect(controls.press).toHaveBeenCalledTimes(1)
    expect(controls.release).not.toHaveBeenCalled()
    pointer(button, 'pointerup')
    expect(controls.release).toHaveBeenCalledTimes(1)
  })

  test('progress 0.42 — кольцо composer-mic-progress с aria-valuenow="42"', () => {
    for (const state of ['download', 'loading'] as const) {
      const button = draw({ voice: voice(state, { progress: 0.42 }), disabled: false, onFallback: () => undefined })
      const ring = button.querySelector('[data-testid="composer-mic-progress"]')
      expect(ring).not.toBeNull()
      expect(ring!.getAttribute('aria-valuenow')).toBe('42')
    }
    const off = draw({ voice: voice('off'), disabled: false, onFallback: () => undefined })
    expect(off.querySelector('[data-testid="composer-mic-progress"]')).toBeNull()
  })

  test('без voice — Win+H, как раньше: прежний title и клик идёт в onFallback', () => {
    const onFallback = vi.fn()
    const button = draw({ disabled: false, onFallback })
    expect(button.title).toBe('Голосовой ввод — диктовка Windows (Win+H). Говорите, текст появится в поле')
    expect(button.getAttribute('aria-label')).toBe('Голосовой ввод')
    expect(button.hasAttribute('data-state')).toBe(false)
    act(() => button.click())
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  test('disabled выключает кнопку', () => {
    expect(draw({ voice: voice('off'), disabled: true, onFallback: () => undefined }).disabled).toBe(true)
  })
})
