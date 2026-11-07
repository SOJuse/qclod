import { describe, expect, test } from 'vitest'
import { SelectionCopyGate } from '@renderer/terminal/selectionCopy'

describe('SelectionCopyGate', () => {
  test('выделение мышью копируется при отпускании кнопки', () => {
    const gate = new SelectionCopyGate()
    gate.pointerDown()
    gate.selectionChanged()
    expect(gate.pointerUp()).toBe(true)
  })

  test('во время протягивания мышью ещё не копируем', () => {
    const gate = new SelectionCopyGate()
    gate.pointerDown()
    expect(gate.selectionChanged()).toBe(false)
  })

  test('Ctrl+A не трогает буфер обмена', () => {
    // Otherwise looking at the scrollback destroys whatever the user had
    // copied a moment earlier.
    const gate = new SelectionCopyGate()
    gate.programmaticSelect()
    expect(gate.selectionChanged()).toBe(false)
    expect(gate.pointerUp()).toBe(false)
  })

  test('отпускание без выделения ничего не копирует', () => {
    const gate = new SelectionCopyGate()
    gate.pointerDown()
    expect(gate.pointerUp()).toBe(false)
  })

  test('следующее протягивание снова копирует', () => {
    const gate = new SelectionCopyGate()
    gate.programmaticSelect()
    gate.pointerUp()

    gate.pointerDown()
    gate.selectionChanged()
    expect(gate.pointerUp()).toBe(true)
  })

  test('повторное отпускание не копирует дважды', () => {
    const gate = new SelectionCopyGate()
    gate.pointerDown()
    gate.selectionChanged()
    expect(gate.pointerUp()).toBe(true)
    expect(gate.pointerUp()).toBe(false)
  })
})
