import { describe, expect, it } from 'vitest'
import type { MaterialUsage, VersionUse } from '../api/types'
import { isValidMaterialCode, isValidNodeTypeCode, materialRules, nodeTypeRules, runRules, scenarioRules } from './rules'

const use = (over: Partial<VersionUse>): VersionUse => ({ version_id: 1, model_key: 'denso-mini', version: 1, status: 'PUBLISHED', nodes: 1, ...over })

describe('nodeTypeRules', () => {
  it('built-in types are always read-only', () => {
    const r = nodeTypeRules({ is_builtin: true }, [])
    expect(r).toMatchObject({ canEdit: false, canDelete: false })
    expect(r.banner).toContain('có sẵn')
  })
  it('a custom type used by a published version is locked and explains why', () => {
    const r = nodeTypeRules({ is_builtin: false }, [use({}), use({ version_id: 2, version: 2 })])
    expect(r).toMatchObject({ canEdit: false, canDelete: false })
    expect(r.banner).toContain('2 version đã Publish')
    expect(r.banner).toContain('denso-mini v1')
  })
  it('a custom type used only by drafts is editable but not deletable', () => {
    const r = nodeTypeRules({ is_builtin: false }, [use({ status: 'DRAFT' })])
    expect(r).toMatchObject({ canEdit: true, canDelete: false })
    expect(r.banner).toContain('nháp')
  })
  it('an unused custom type is free to edit and delete', () => {
    expect(nodeTypeRules({ is_builtin: false }, [])).toEqual({ canEdit: true, canDelete: true, banner: null })
  })
  it('truncates long lists of versions in the banner', () => {
    const many = [1, 2, 3, 4, 5].map((v) => use({ version_id: v, version: v }))
    expect(nodeTypeRules({ is_builtin: false }, many).banner).toContain('…')
  })
})

describe('materialRules', () => {
  const empty: MaterialUsage = { edges: [], nodes: [], node_types: [] }
  it('lets an unused material be edited and deleted', () => {
    expect(materialRules(empty)).toEqual({ canEdit: true, canDelete: true, banner: null, canEditUnit: true })
  })
  it('locks unit and deletion once anything references it, but keeps the name editable', () => {
    const r = materialRules({ ...empty, nodes: [{ version_id: 1, model_key: 'm', version: 1, key: 'SRC', node_type: 'DOCK_IN' }] })
    expect(r).toMatchObject({ canEdit: true, canDelete: false, canEditUnit: false })
    expect(r.banner).toContain('1 node')
  })
  it('counts references in node types too', () => {
    expect(materialRules({ ...empty, node_types: ['CUST'] })).toMatchObject({ canDelete: false })
  })
})

describe('code validation', () => {
  it('accepts upper snake node type codes only', () => {
    expect(isValidNodeTypeCode('LASER_CUT')).toBe(true)
    expect(isValidNodeTypeCode('laser')).toBe(false)
    expect(isValidNodeTypeCode('1ABC')).toBe(false)
    expect(isValidNodeTypeCode('')).toBe(false)
  })
  it('accepts material codes with digits and dashes', () => {
    expect(isValidMaterialCode('RAW-01')).toBe(true)
    expect(isValidMaterialCode('SUB_OK')).toBe(true)
    expect(isValidMaterialCode('a b')).toBe(false)
    expect(isValidMaterialCode('-x')).toBe(false)
  })
})

describe('scenarioRules and runRules', () => {
  it('locks editing once a scenario has runs but always allows delete and clone', () => {
    expect(scenarioRules(0)).toEqual({ canEdit: true, canDelete: true, banner: null })
    const r = scenarioRules(3)
    expect(r).toMatchObject({ canEdit: false, canDelete: true })
    expect(r.banner).toContain('3 lần chạy')
    expect(r.banner).toContain('Nhân bản')
  })
  it('only finished runs can be deleted', () => {
    expect(runRules('DONE').canDelete).toBe(true)
    expect(runRules('FAILED').canDelete).toBe(true)
    expect(runRules('QUEUED').canDelete).toBe(false)
    expect(runRules('RUNNING').canDelete).toBe(false)
  })
})
