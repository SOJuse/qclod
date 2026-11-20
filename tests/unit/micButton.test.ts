import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MicButton } from '../../src/renderer/components/composer/MicButton'
import type { VoiceButtonState, VoiceControls } from '../../src/shared/voice'

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

const html = (props: Parameters<typeof MicButton>[0]): string => renderToStaticMarkup(createElement(MicButton, props))
const attr = (markup: string, name: string): string | null => markup.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null

describe('MicButton', () => {
  test('пять состояний дают свой data-state, title и aria-label — voice.title', () => {
    for (const state of ['off', 'listening', 'download', 'loading', 'unavailable'] as const) {
      const markup = html({ voice: voice(state), disabled: false, onFallback: () => undefined })
      expect(attr(markup, 'data-testid')).toBe('composer-mic')
      expect(attr(markup, 'data-state')).toBe(state)
      expect(attr(markup, 'title')).toBe(`голос: ${state}`)
      expect(attr(markup, 'aria-label')).toBe(`голос: ${state}`)
    }
  })

  test('listening — aria-pressed="true", остальные — false', () => {
    expect(attr(html({ voice: voice('listening'), disabled: false, onFallback: () => undefined }), 'aria-pressed')).toBe('true')
    expect(attr(html({ voice: voice('off'), disabled: false, onFallback: () => undefined }), 'aria-pressed')).toBe('false')
  })

  test('pointerdown зовёт press, pointerup — release', () => {
    const controls = voice('off')
    // No DOM in these tests (no jsdom in the project): the element's own handlers are called, as React would.
    const button = MicButton({ voice: controls, disabled: false, onFallback: () => undefined }) as ReactElement
    const event = { button: 0, preventDefault: vi.fn() }
    button.props.onPointerDown(event)
    expect(controls.press).toHaveBeenCalledTimes(1)
    expect(controls.release).not.toHaveBeenCalled()
    button.props.onPointerUp(event)
    expect(controls.release).toHaveBeenCalledTimes(1)
  })

  test('progress 0.42 — кольцо composer-mic-progress с aria-valuenow="42"', () => {
    for (const state of ['download', 'loading'] as const) {
      const markup = html({ voice: voice(state, { progress: 0.42 }), disabled: false, onFallback: () => undefined })
      const ring = markup.match(/<[^>]*data-testid="composer-mic-progress"[^>]*>/)?.[0] ?? ''
      expect(ring).not.toBe('')
      expect(attr(ring, 'aria-valuenow')).toBe('42')
    }
    expect(html({ voice: voice('off'), disabled: false, onFallback: () => undefined })).not.toContain('composer-mic-progress')
  })

  test('без voice — Win+H, как раньше: прежний title и клик идёт в onFallback', () => {
    const markup = html({ disabled: false, onFallback: () => undefined })
    expect(attr(markup, 'title')).toBe('Голосовой ввод — диктовка Windows (Win+H). Говорите, текст появится в поле')
    expect(attr(markup, 'aria-label')).toBe('Голосовой ввод')
    expect(attr(markup, 'data-state')).toBeNull()
    const onFallback = vi.fn()
    const button = MicButton({ disabled: false, onFallback }) as ReactElement
    button.props.onClick()
    expect(onFallback).toHaveBeenCalledTimes(1)
  })

  test('disabled выключает кнопку', () => {
    expect(html({ voice: voice('off'), disabled: true, onFallback: () => undefined })).toContain('disabled=""')
  })
})
