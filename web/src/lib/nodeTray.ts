import type { AgvMap, GraphEdge, GraphNode } from '../api/types'

export type TrayNode = { key: string; name: string; needed: boolean; stations: number; archetype?: string; icon?: string }

/** Phần của loại node mà khay cần: vai trò và biểu tượng (ui.icon). */
export type TrayType = { archetype: string; ui?: unknown }

/** Các node nằm ở đầu hay cuối một đường nối do xe chở (POOL): xe phải tới được nên cần trạm nối vào đường. Node khác (băng chuyền, máy đứng riêng) không bắt buộc. */
export function servedNodes(edges: GraphEdge[]): Set<string> {
  const out = new Set<string>()
  for (const e of edges) if (e.params?.mode === 'POOL') { out.add(e.src); out.add(e.dst) }
  return out
}

/**
 * Danh sách node của sơ đồ để đặt lên bản đồ. `needed`: node có xe chở tới (xem `servedNodes`); `stations`: số trạm đã đặt cho node
 * (nhiều chỗ đỗ thì nhiều hơn 1). Xếp node cần mà chưa đặt lên đầu, node đã đặt xuống cuối. `names` là tên hiển thị theo loại node khi node không tự đặt tên.
 * `skip`: node không có vị trí trên mặt bằng (đội xe, người vận hành) nên không đưa vào khay. `types` (nếu có) cho vai trò và biểu tượng để vẽ ô icon.
 */
export function trayNodes(nodes: GraphNode[], edges: GraphEdge[], map: AgvMap, names: Record<string, string>, query: string, skip: Set<string> = new Set(),
  types: Record<string, TrayType> = {}): TrayNode[] {
  const needed = servedNodes(edges)
  const stations = new Map<string, number>()
  for (const p of map.points) if (p.kind === 'station' && p.node_key) stations.set(p.node_key, (stations.get(p.node_key) ?? 0) + 1)
  const q = query.trim().toLowerCase()
  const iconOf = (t: TrayType | undefined) => {
    const icon = (t?.ui as { icon?: unknown } | undefined)?.icon
    return typeof icon === 'string' && icon !== '' ? icon : undefined
  }
  const all = nodes.filter((n) => !skip.has(n.key)).map<TrayNode>((n) => {
    const t = types[n.node_type]
    return { key: n.key, name: n.name || names[n.key] || n.key, needed: needed.has(n.key), stations: stations.get(n.key) ?? 0,
      archetype: n.archetype || t?.archetype, icon: iconOf(t) }
  })
  const rank = (n: TrayNode) => (n.stations > 0 ? 2 : n.needed ? 0 : 1)
  return all
    .filter((n) => q === '' || n.key.toLowerCase().includes(q) || n.name.toLowerCase().includes(q))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map(({ n }) => n)
}
