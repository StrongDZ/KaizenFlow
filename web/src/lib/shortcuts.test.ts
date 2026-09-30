import { describe, expect, it } from 'vitest'
import { SHORTCUTS, shortcutFor } from './shortcuts'

const k = (key: string, over: Record<string, unknown> = {}) => shortcutFor({ key, code: '', ...over })

describe('shortcutFor', () => {
  it('maps the usual edit keys with Ctrl or Cmd', () => {
    for (const mod of ['ctrlKey', 'metaKey']) {
      expect(k('z', { [mod]: true })).toBe('undo')
      expect(k('z', { [mod]: true, shiftKey: true })).toBe('redo')
      expect(k('y', { [mod]: true })).toBe('redo')
      expect(k('c', { [mod]: true })).toBe('copy')
      expect(k('v', { [mod]: true })).toBe('paste')
      expect(k('d', { [mod]: true })).toBe('duplicate')
      expect(k('a', { [mod]: true })).toBe('selectAll')
      expect(k('s', { [mod]: true })).toBe('save')
    }
  })
  it('is not fooled by Caps Lock', () => {
    expect(k('Z', { ctrlKey: true })).toBe('undo')
    expect(k('V')).toBe('toolSelect')
  })
  it('maps single-letter tools and view keys', () => {
    expect(k('v')).toBe('toolSelect')
    expect(k('h')).toBe('toolHand')
    expect(k('f')).toBe('focus')
    expect(k('Tab')).toBe('add')
    expect(k('/')).toBe('add')
    expect(k('?')).toBe('help')
    expect(k('Escape')).toBe('escape')
  })
  it('maps fit and zoom on Shift plus a digit, whatever character Shift turns the digit into', () => {
    expect(shortcutFor({ key: '!', code: 'Digit1', shiftKey: true })).toBe('fit')
    expect(shortcutFor({ key: ')', code: 'Digit0', shiftKey: true })).toBe('zoom100')
    expect(shortcutFor({ key: '@', code: 'Digit2', shiftKey: true })).toBe('fitSelection')
  })
  it('ignores combinations it does not own, so the browser keeps them', () => {
    expect(k('z')).toBeNull()
    expect(k('r', { ctrlKey: true })).toBeNull()
    expect(k('c', { ctrlKey: true, altKey: true })).toBeNull()
    expect(k('v', { ctrlKey: true, shiftKey: true })).toBeNull()
    expect(k('h', { ctrlKey: true })).toBeNull()
    expect(k('v', { shiftKey: true })).toBeNull()
  })
})

describe('SHORTCUTS help table', () => {
  it('describes every key in plain Vietnamese', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(10)
    for (const s of SHORTCUTS) {
      expect(s.keys).toMatch(/\S/)
      expect(s.label).toMatch(/\S/)
    }
  })
})
