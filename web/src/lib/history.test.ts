import { describe, expect, it } from 'vitest'
import { canRedo, canUndo, emptyHistory, record, redo, undo } from './history'

describe('history', () => {
  it('goes back to the state before an edit, and forward again', () => {
    let h = emptyHistory<string>()
    h = record(h, 'A') // sắp sửa A thành B
    const back = undo(h, 'B')
    expect(back?.state).toBe('A')
    expect(canRedo(back!.history)).toBe(true)
    const fwd = redo(back!.history, 'A')
    expect(fwd?.state).toBe('B')
    expect(canUndo(fwd!.history)).toBe(true)
  })

  it('steps back through several edits in reverse order', () => {
    let h = emptyHistory<string>()
    h = record(h, 'A')
    h = record(h, 'B')
    h = record(h, 'C')
    const s1 = undo(h, 'D')!
    const s2 = undo(s1.history, s1.state)!
    const s3 = undo(s2.history, s2.state)!
    expect([s1.state, s2.state, s3.state]).toEqual(['C', 'B', 'A'])
    expect(undo(s3.history, s3.state)).toBeNull()
  })

  it('forgets what could be redone once a new edit is made', () => {
    let h = emptyHistory<string>()
    h = record(h, 'A')
    const back = undo(h, 'B')!
    expect(canRedo(back.history)).toBe(true)
    const h2 = record(back.history, 'A')
    expect(canRedo(h2)).toBe(false)
  })

  it('has nothing to undo or redo at the start', () => {
    const h = emptyHistory<string>()
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
    expect(undo(h, 'A')).toBeNull()
    expect(redo(h, 'A')).toBeNull()
  })

  it('merges rapid edits of the same thing into one step, so typing a number is one undo', () => {
    let h = emptyHistory<string>()
    h = record(h, 'v0', { key: 'node:A', now: 0 })
    h = record(h, 'v1', { key: 'node:A', now: 300 })
    h = record(h, 'v2', { key: 'node:A', now: 600 })
    const back = undo(h, 'v3')!
    expect(back.state).toBe('v0')
    expect(canUndo(back.history)).toBe(false)
  })

  it('starts a new step for another target, or after a pause', () => {
    let h = emptyHistory<string>()
    h = record(h, 'v0', { key: 'node:A', now: 0 })
    h = record(h, 'v1', { key: 'node:B', now: 100 })
    h = record(h, 'v2', { key: 'node:B', now: 5000 })
    const s1 = undo(h, 'v3')!
    const s2 = undo(s1.history, s1.state)!
    const s3 = undo(s2.history, s2.state)!
    expect([s1.state, s2.state, s3.state]).toEqual(['v2', 'v1', 'v0'])
  })

  it('does not merge an edit into the step that was just undone', () => {
    let h = emptyHistory<string>()
    h = record(h, 'v0', { key: 'node:A', now: 0 })
    const back = undo(h, 'v1')!
    const h2 = record(back.history, 'v0', { key: 'node:A', now: 100 })
    expect(canUndo(h2)).toBe(true)
  })

  it('keeps only the newest steps when it grows past the limit', () => {
    let h = emptyHistory<number>()
    for (let i = 0; i < 10; i++) h = record(h, i, { limit: 3 })
    const s1 = undo(h, 10)!
    const s2 = undo(s1.history, s1.state)!
    const s3 = undo(s2.history, s2.state)!
    expect([s1.state, s2.state, s3.state]).toEqual([9, 8, 7])
    expect(undo(s3.history, s3.state)).toBeNull()
  })
})
