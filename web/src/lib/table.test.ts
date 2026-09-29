import { describe, expect, it } from 'vitest'
import { comparePath, filterRows, isRowEnter, nextSort, norm, sortRows, toggleCompare } from './table'

describe('norm and filterRows', () => {
  it('ignores case and Vietnamese diacritics', () => {
    expect(norm('Máy Dập 3')).toBe('may dap 3')
    expect(norm('Đóng gói')).toBe('dong goi')
  })
  const rows = [{ n: 'Máy dập', c: 'STAMP_PRESS' }, { n: 'Kho kệ', c: 'RACK' }]
  it('matches any field and returns all rows for an empty query', () => {
    expect(filterRows(rows, 'DAP', (r) => [r.n, r.c])).toEqual([rows[0]])
    expect(filterRows(rows, 'rack', (r) => [r.n, r.c])).toEqual([rows[1]])
    expect(filterRows(rows, '  ', (r) => [r.n])).toEqual(rows)
    expect(filterRows(rows, 'zzz', (r) => [r.n, undefined, null])).toEqual([])
  })
})

describe('sortRows and nextSort', () => {
  const rows = [{ k: 'b', n: 2 }, { k: 'a', n: null }, { k: 'c', n: 1 }]
  it('sorts numbers and strings and keeps nulls last in both directions', () => {
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.k)).toEqual(['c', 'b', 'a'])
    expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.k)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, (r) => r.k, 'desc').map((r) => r.k)).toEqual(['c', 'b', 'a'])
    expect(sortRows(rows, undefined, 'asc')).toBe(rows)
  })
  it('does not mutate its input and toggles direction', () => {
    const copy = [...rows]
    sortRows(rows, (r) => r.k, 'asc')
    expect(rows).toEqual(copy)
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'asc' })
    expect(nextSort({ key: 'a', dir: 'asc' }, 'a')).toEqual({ key: 'a', dir: 'desc' })
    expect(nextSort({ key: 'a', dir: 'desc' }, 'b')).toEqual({ key: 'b', dir: 'asc' })
  })
})

describe('compare selection', () => {
  it('keeps at most two runs, dropping the oldest pick', () => {
    expect(toggleCompare([], 5)).toEqual([5])
    expect(toggleCompare([5], 9)).toEqual([5, 9])
    expect(toggleCompare([5, 9], 12)).toEqual([9, 12])
    expect(toggleCompare([5, 9], 5)).toEqual([9])
  })
  it('opens the comparison with the older run as baseline, only for exactly two', () => {
    expect(comparePath([9, 5])).toBe('/compare?a=5&b=9')
    expect(comparePath([5])).toBeNull()
    expect(comparePath([])).toBeNull()
  })
})

describe('row activation', () => {
  it('opens a row on Enter only when the row itself has focus, not a button or checkbox inside it', () => {
    const row = {}
    const button = {}
    expect(isRowEnter('Enter', row, row)).toBe(true)
    expect(isRowEnter('Enter', button, row)).toBe(false)
    expect(isRowEnter(' ', row, row)).toBe(false)
    expect(isRowEnter('Tab', row, row)).toBe(false)
  })
})
