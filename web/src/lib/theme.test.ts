import { describe, expect, it } from 'vitest'
import { THEME_KEY, otherTheme, parseTheme, readStored } from './theme'

describe('parseTheme', () => {
  it('keeps the two known values and falls back to dark for anything else', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme(null)).toBe('dark')
    expect(parseTheme('sepia')).toBe('dark')
  })
})

describe('otherTheme', () => {
  it('flips between the two', () => {
    expect(otherTheme('dark')).toBe('light')
    expect(otherTheme('light')).toBe('dark')
  })
})

describe('readStored', () => {
  it('reads the saved choice', () => {
    expect(readStored({ getItem: (k) => (k === THEME_KEY ? 'light' : null) })).toBe('light')
  })
  it('survives storage that is missing or throws (private window, blocked site data)', () => {
    expect(readStored(undefined)).toBe('dark')
    expect(readStored({ getItem: () => { throw new Error('denied') } })).toBe('dark')
  })
})
