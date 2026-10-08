import type { EventRow, Graph, GraphNode, NodeType } from '../api/types'
import type { ScenarioForm } from './scenarioForm'
import { failureModesOf, poolCount } from './model'
import type { MaintenanceWindow, Zone } from './ruler'

export type ScenarioTemplateKey = 'baseline' | 'failure' | 'maintenance' | 'resource'
export type ScenarioTemplate = { key: ScenarioTemplateKey; title: string; description: string; available: boolean }

export function scenarioTemplates(graph: Graph, types: Record<string, NodeType>): ScenarioTemplate[] {
  const faultable = graph.nodes.some((node) => failureModesOf(node, types).length > 0)
  return [
    { key: 'baseline', title: 'Ca vận hành chuẩn', description: 'Không tiêm sự cố; tạo mốc KPI để so sánh.', available: true },
    { key: 'failure', title: 'Sự cố máy', description: 'Tiêm lỗi giữa ca để quan sát tác động dây chuyền.', available: faultable },
    { key: 'maintenance', title: 'Bảo trì có kế hoạch', description: 'Dừng một công đoạn 30 phút và kiểm tra phục hồi.', available: graph.nodes.some((node) => node.archetype === 'PROCESS') },
    { key: 'resource', title: 'Tăng nguồn lực', description: 'Thêm một xe/người vào resource pool để kiểm chứng năng lực.', available: graph.nodes.some((node) => node.archetype === 'RESOURCE_POOL') },
  ]
}

export function applyScenarioTemplate(key: ScenarioTemplateKey, current: ScenarioForm, graph: Graph, types: Record<string, NodeType>): ScenarioForm {
  const horizonMinutes = Math.max(15, Math.round(current.hours * 60))
  const eventAt = Math.max(1, Math.min(60, Math.round(horizonMinutes / 3)))
  const base = { ...current, inj: [], ovr: [], extra: [] }
  if (key === 'baseline') return { ...base, name: 'Baseline · ca vận hành chuẩn' }
  if (key === 'failure') {
    const node = graph.nodes.find((item) => failureModesOf(item, types).length > 0)
    if (!node) return current
    return {
      ...base,
      name: `Sự cố ${node.name || node.key} ở phút ${eventAt}`,
      inj: [{ target: node.key, kind: 'failure', failure: failureModesOf(node, types)[0] ?? '', at_min: eventAt, duration_min: 30 }],
    }
  }
  if (key === 'maintenance') {
    const node = graph.nodes.find((item) => item.archetype === 'PROCESS')
    if (!node) return current
    return {
      ...base,
      name: `Bảo trì ${node.name || node.key} ở phút ${eventAt}`,
      inj: [{ target: node.key, kind: 'planned_stop', failure: '', at_min: eventAt, duration_min: Math.min(30, Math.max(5, horizonMinutes - eventAt)) }],
    }
  }
  const pool = graph.nodes.find((item) => item.archetype === 'RESOURCE_POOL')
  if (!pool) return current
  return { ...base, name: `Tăng nguồn lực ${pool.name || pool.key}`, ovr: [{ target: pool.key, count: poolCount(pool, types) + 1 }] }
}

export function downstreamKeys(graph: Pick<Graph, 'nodes' | 'edges'>, start: string, maxDepth = 4): string[] {
  const found = new Set<string>([start])
  let frontier = [start]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next = graph.edges.filter((edge) => frontier.includes(edge.src)).map((edge) => edge.dst).filter((key) => !found.has(key))
    next.forEach((key) => found.add(key))
    frontier = next
  }
  return [...found].filter((key) => graph.nodes.some((node) => node.key === key))
}

export type StoryBookmark = {
  id: string
  t: number
  label: string
  detail: string
  tone: 'info' | 'warn' | 'bad' | 'ok'
  target?: string
}

export function storyBookmarks(args: {
  times: number[]
  events: EventRow[]
  maintenance: MaintenanceWindow[]
  zones: Zone[]
}): StoryBookmark[] {
  const { times, events, maintenance, zones } = args
  if (times.length === 0) return []
  const out: StoryBookmark[] = [{ id: 'start', t: times[0], label: 'Bắt đầu', detail: 'Trạng thái đầu ca và baseline vận hành.', tone: 'info' }]
  events.filter((event) => event.rep === 0 && event.type === 'FAILURE').forEach((event, index) => out.push({
    id: `failure-${index}`, t: Date.parse(event.t), label: `${event.subject} gặp sự cố`, detail: 'Theo dõi ảnh hưởng lan sang công đoạn trước và sau.', tone: 'bad', target: event.subject,
  }))
  maintenance.forEach((window, index) => {
    out.push({ id: `maintenance-start-${index}`, t: window.from, label: `Bắt đầu bảo trì ${window.target}`, detail: 'Máy ngừng nhận và nhả hàng trong cửa sổ bảo trì.', tone: 'warn', target: window.target })
    out.push({ id: `maintenance-end-${index}`, t: window.to, label: `Kết thúc bảo trì ${window.target}`, detail: 'Kiểm tra tốc độ phục hồi và hàng tồn sau máy.', tone: 'ok', target: window.target })
  })
  if (zones.length > 0) out.push({ id: 'first-red', t: zones[0].from, label: 'Tồn kho chuyển Đỏ', detail: 'Mốc đầu tiên cần quyết định trước khi thiếu hàng lan rộng.', tone: 'bad' })
  out.push({ id: 'end', t: times[times.length - 1], label: 'Kết thúc', detail: 'Tổng kết KPI và mở báo cáo.', tone: 'ok' })
  return out.filter((item) => Number.isFinite(item.t)).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
    .filter((item, index, rows) => index === 0 || item.id === 'end' || Math.abs(item.t - rows[index - 1].t) > 1 || item.target !== rows[index - 1].target)
}

export function affectedNodeNames(graph: Graph, targets: string[]): GraphNode[] {
  const keys = new Set(targets.flatMap((target) => downstreamKeys(graph, target)))
  return graph.nodes.filter((node) => keys.has(node.key))
}

export function comparisonSummarySvg(input: {
  baselineId: number
  candidateId: number
  candidateName: string
  metrics: Array<{ label: string; before: number; after: number; unit?: string }>
}): string {
  const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!))
  const rows = input.metrics.map((metric, index) => {
    const y = 210 + index * 72
    const delta = metric.after - metric.before
    return `<text x="70" y="${y}" fill="#94a3b8" font-size="20">${esc(metric.label)}</text><text x="560" y="${y}" fill="#e2e8f0" font-size="22" text-anchor="end">${metric.before.toFixed(1)}${esc(metric.unit ?? '')}</text><text x="625" y="${y}" fill="#64748b" font-size="22">→</text><text x="930" y="${y}" fill="${delta <= 0 && metric.label !== 'Sản lượng' ? '#4ade80' : delta >= 0 && metric.label === 'Sản lượng' ? '#4ade80' : '#f8fafc'}" font-size="22" font-weight="700" text-anchor="end">${metric.after.toFixed(1)}${esc(metric.unit ?? '')}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${280 + input.metrics.length * 72}" viewBox="0 0 1000 ${280 + input.metrics.length * 72}"><rect width="100%" height="100%" rx="28" fill="#0f172a"/><text x="70" y="78" fill="#f8fafc" font-size="34" font-family="Arial" font-weight="700">KaizenFlow · Kết quả kiểm chứng</text><text x="70" y="120" fill="#94a3b8" font-size="20" font-family="Arial">Run #${input.baselineId} → Run #${input.candidateId}</text><text x="70" y="154" fill="#38bdf8" font-size="20" font-family="Arial">${esc(input.candidateName)}</text><line x1="70" x2="930" y1="174" y2="174" stroke="#334155"/>${rows}<text x="70" y="${235 + input.metrics.length * 72}" fill="#64748b" font-size="16" font-family="Arial">Xuất từ KaizenFlow · số liệu trung vị p50</text></svg>`
}
