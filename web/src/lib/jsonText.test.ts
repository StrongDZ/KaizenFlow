import { describe, expect, it } from 'vitest'
import { parseJsonArray } from './jsonText'

describe('parseJsonArray', () => {
  it('accepts an array of objects and an empty text', () => {
    expect(parseJsonArray('[{"name":"a"}]')).toEqual({ ok: true, value: [{ name: 'a' }] })
    expect(parseJsonArray('  ')).toEqual({ ok: true, value: [] })
    expect(parseJsonArray('[]')).toEqual({ ok: true, value: [] })
  })
  it('rejects broken JSON, non-arrays and non-object items with a message', () => {
    const broken = parseJsonArray('[{"name":')
    expect(broken.ok).toBe(false)
    expect(broken.ok === false && broken.error).toContain('JSON không hợp lệ')
    expect(parseJsonArray('{"a":1}')).toEqual({ ok: false, error: 'Cần một mảng JSON, ví dụ [ { … } ].' })
    expect(parseJsonArray('[1,2]')).toEqual({ ok: false, error: 'Mỗi phần tử của mảng phải là một object.' })
    expect(parseJsonArray('[null]')).toEqual({ ok: false, error: 'Mỗi phần tử của mảng phải là một object.' })
  })
})
