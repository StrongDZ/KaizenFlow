import { describe, expect, it } from 'vitest'
import { isTypingTarget, nextSpeed, stepIndex, tickMs } from './playback'

describe('stepIndex', () => {
  it('steps by one, or ten with shift, clamped at both ends', () => {
    expect(stepIndex(5, 100, 'ArrowRight', false)).toBe(6)
    expect(stepIndex(5, 100, 'ArrowLeft', false)).toBe(4)
    expect(stepIndex(5, 100, 'ArrowRight', true)).toBe(15)
    expect(stepIndex(5, 100, 'ArrowLeft', true)).toBe(0)
    expect(stepIndex(95, 100, 'ArrowRight', true)).toBe(99)
    expect(stepIndex(50, 100, 'Home', false)).toBe(0)
    expect(stepIndex(50, 100, 'End', false)).toBe(99)
  })
  it('ignores other keys and empty timelines', () => {
    expect(stepIndex(5, 100, 'a', false)).toBe(5)
    expect(stepIndex(5, 0, 'ArrowRight', false)).toBe(0)
    expect(stepIndex(0, 1, 'ArrowRight', true)).toBe(0)
  })
})

describe('speed', () => {
  it('cycles 1 → 4 → 16 → 1 and shortens the tick', () => {
    expect(nextSpeed(1)).toBe(4)
    expect(nextSpeed(4)).toBe(16)
    expect(nextSpeed(16)).toBe(1)
    expect(tickMs(1)).toBe(120)
    expect(tickMs(4)).toBe(30)
  })
})

describe('isTypingTarget', () => {
  it('protects form fields from hotkeys', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
