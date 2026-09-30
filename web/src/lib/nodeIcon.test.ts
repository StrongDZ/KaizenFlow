import { describe, expect, it } from 'vitest'
import { hasIcon } from '../components/nodeIcons'
import { ICON_CHOICES, withIcon } from './iconChoices'

describe('withIcon', () => {
  it('sets the icon and leaves the other ui keys alone (the API replaces the whole ui object)', () => {
    expect(withIcon({ icon: 'truck', color: '#111111' }, 'bot')).toEqual({ icon: 'bot', color: '#111111' })
    expect(withIcon(undefined, 'cog')).toEqual({ icon: 'cog' })
  })
  it('removes the icon when none is chosen, so the node falls back to the icon of its role', () => {
    expect(withIcon({ icon: 'truck', color: '#111111' }, undefined)).toEqual({ color: '#111111' })
    expect(withIcon({ icon: 'truck' }, undefined)).toEqual({})
  })
  it('does not change what it was given', () => {
    const ui = { icon: 'truck' }
    withIcon(ui, 'bot')
    expect(ui).toEqual({ icon: 'truck' })
  })
})

describe('ICON_CHOICES', () => {
  it('offers every icon the built-in node types already use, so opening one of them never shows "no icon selected"', () => {
    const builtin = ['truck', 'search', 'warehouse', 'store', 'inbox', 'hammer', 'puzzle', 'scan', 'package', 'send', 'trash', 'tractor', 'bot', 'user']
    const names = ICON_CHOICES.map((c) => c.name)
    for (const b of builtin) expect(names, b).toContain(b)
  })
  it('has unique names, a plain-language label each, and a drawable icon behind each', () => {
    const names = ICON_CHOICES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of ICON_CHOICES) {
      expect(c.label, c.name).toMatch(/\S/)
      expect(hasIcon(c.name), c.name).toBe(true)
    }
  })
  it('does not pretend an unknown name has an icon', () => {
    expect(hasIcon('no-such-icon')).toBe(false)
  })
})
