import { describe, expect, it } from 'vitest'
import type { CoverageReport, SubjectView } from '../api/types'
import { FEATURE_LABEL, filterSubjects, groupNodes, indexCoverage, isBound, readinessLabel, splitSubjects, statusOf } from './connectView'

const sig = (name: string) => ({ name, label: name, kind: 'number' as const })
const node = (subject: string, archetype: string, name = subject): SubjectView => ({ subject, kind: 'node', name, archetype, signals: [sig('a'), sig('b')] })
const edge = (subject: string, name: string): SubjectView => ({ subject, kind: 'edge', name, material: 'RAW-01', signals: [sig('moved')] })

const subjects: SubjectView[] = [
  node('P1', 'PROCESS', 'Máy dập 1'), node('K', 'STORAGE', 'Kho A'), node('S', 'SOURCE', 'Nhà cung cấp'),
  edge('S>K', 'Nhà cung cấp → Kho A'), node('P2', 'PROCESS', 'Máy dập 2'), node('T', 'RESOURCE_POOL', 'Xe kéo'), node('O', 'SINK', 'Cửa xuất'),
  edge('K>P1', 'Kho A → Máy dập 1'),
]

const report: CoverageReport = {
  summary: { signals: 5, source: 2, derived: 1, missing: 1, broken: 1 },
  readiness: [],
  signals: [
    { subject: 'P1', signal: 'a', label: 'a', status: 'source', need: [] },
    { subject: 'P1', signal: 'b', label: 'b', status: 'derived', need: [] },
    { subject: 'P2', signal: 'a', label: 'a', status: 'missing', need: ['live'] },
    { subject: 'P2', signal: 'b', label: 'b', status: 'broken', need: [], reason: 'hỏng' },
    { subject: 'K', signal: 'a', label: 'a', status: 'source', need: [] },
  ],
  problems: [],
}

describe('splitSubjects', () => {
  it('tách node và edge, giữ thứ tự', () => {
    const { nodes, edges } = splitSubjects(subjects)
    expect(nodes.map((s) => s.subject)).toEqual(['P1', 'K', 'S', 'P2', 'T', 'O'])
    expect(edges.map((s) => s.subject)).toEqual(['S>K', 'K>P1'])
  })
})

describe('groupNodes', () => {
  it('nhóm theo vai trò theo thứ tự Nguồn, Kho, Trạm, Đích, Đội xe; bỏ nhóm rỗng', () => {
    const labels = { SOURCE: 'Nguồn', STORAGE: 'Kho', PROCESS: 'Trạm', SINK: 'Đích', RESOURCE_POOL: 'Đội xe' }
    const g = groupNodes(splitSubjects(subjects).nodes, labels)
    expect(g.map((x) => x.title)).toEqual(['Nguồn', 'Kho', 'Trạm', 'Đích', 'Đội xe'])
    expect(g[2].subjects.map((s) => s.subject)).toEqual(['P1', 'P2'])
    expect(groupNodes([node('S', 'SOURCE')], labels).map((x) => x.key)).toEqual(['SOURCE'])
  })
})

describe('coverage index', () => {
  const idx = indexCoverage(report)
  it('tra trạng thái theo đối tượng và tín hiệu', () => {
    expect(statusOf(idx, 'P1', 'a')).toBe('source')
    expect(statusOf(idx, 'P2', 'b')).toBe('broken')
    expect(statusOf(idx, 'ZZ', 'a')).toBeUndefined()
    expect(statusOf(indexCoverage(undefined), 'P1', 'a')).toBeUndefined()
  })
  it('đã có gì: nguồn hoặc tự tính mới tính là đã ghép', () => {
    expect(isBound('source')).toBe(true)
    expect(isBound('derived')).toBe(true)
    expect(isBound('missing')).toBe(false)
    expect(isBound('broken')).toBe(false)
    expect(isBound(undefined)).toBe(false)
  })
})

describe('filterSubjects', () => {
  const idx = indexCoverage(report)
  const nodes = splitSubjects(subjects).nodes
  it('chuỗi tìm khớp tên hoặc khoá', () => {
    expect(filterSubjects(nodes, idx, { q: 'dập', onlyMissing: false }).map((s) => s.subject)).toEqual(['P1', 'P2'])
    expect(filterSubjects(nodes, idx, { q: 'p2', onlyMissing: false }).map((s) => s.subject)).toEqual(['P2'])
  })
  it('chỉ chưa ghép đủ: còn tín hiệu chưa có hoặc hỏng', () => {
    // P1 đủ (nguồn + tự tính); K mới có a, thiếu b (chưa có trong báo cáo); P2 thiếu và hỏng
    expect(filterSubjects(nodes, idx, { q: '', onlyMissing: true }).map((s) => s.subject)).toEqual(['K', 'S', 'P2', 'T', 'O'])
  })
  it('lọc theo chức năng: chỉ những đối tượng có tín hiệu thiếu cho chức năng đó', () => {
    expect(filterSubjects(nodes, idx, { q: '', onlyMissing: false, feature: 'live', missingFor: new Set(['P2|a']) }).map((s) => s.subject)).toEqual(['P2'])
  })
})

describe('readinessLabel', () => {
  it('đủ hoặc thiếu bao nhiêu', () => {
    expect(readinessLabel({ feature: 'live', ok: true, missing: [] })).toBe(`${FEATURE_LABEL.live}: đủ`)
    expect(readinessLabel({ feature: 'forecast', ok: false, missing: [{ subject: 'K', signal: 'x' }, { subject: 'K2', signal: 'x' }] })).toBe(`${FEATURE_LABEL.forecast}: thiếu 2`)
  })
})
