import { edgeKey, edgeLabel, type FlowEdge, type FlowNode } from './graph'

/** Nội dung đã sao chép: các node được chọn và những edge nối hai node cùng được chọn. */
export type Clip = { nodes: FlowNode[]; edges: FlowEdge[] }

/** Khoá kế tiếp chưa dùng, đếm tiếp từ số ở cuối khoá (STAMP_1 thành STAMP_2 hoặc số trống tiếp theo). */
export function nextKey(existing: string[], key: string): string {
  const m = /^(.*?)_(\d+)$/.exec(key)
  const base = m ? m[1] : key
  let n = m ? Number(m[2]) + 1 : 2
  while (existing.includes(`${base}_${n}`)) n++
  return `${base}_${n}`
}

export function copyOf(nodes: FlowNode[], edges: FlowEdge[]): Clip | null {
  const picked = nodes.filter((n) => n.selected)
  if (picked.length === 0) return null
  const ids = new Set(picked.map((n) => n.id))
  return {
    nodes: picked.map((n) => ({
      id: n.id, type: n.type, position: { ...n.position },
      data: {
        key: n.data.key, nodeType: n.data.nodeType, archetype: n.data.archetype, name: n.data.name,
        params: structuredClone(n.data.params), icon: n.data.icon,
      },
    })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({
      id: e.id, source: e.source, target: e.target,
      data: { material: e.data?.material ?? '', params: structuredClone(e.data?.params ?? {}) },
    })),
  }
}

/**
 * Bản dán: node có khoá mới, lệch `offset` để không đè lên bản gốc, và được chọn sẵn; edge nối lại giữa các bản sao.
 * Edge dùng đội xe hay người móc kéo cũng được sao chép thì trỏ sang bản sao của chúng, không thì giữ nguyên.
 */
export function pasteOf(clip: Clip, { nodeKeys, edgeKeys, offset }: { nodeKeys: string[]; edgeKeys: string[]; offset: number }): Clip {
  const used = [...nodeKeys]
  const keyMap = new Map<string, string>()
  for (const n of clip.nodes) {
    const k = nextKey(used, n.id)
    used.push(k)
    keyMap.set(n.id, k)
  }
  const nodes: FlowNode[] = clip.nodes.map((n) => {
    const key = keyMap.get(n.id) as string
    return {
      id: key, type: n.type, position: { x: n.position.x + offset, y: n.position.y + offset }, selected: true,
      data: { ...n.data, key, params: structuredClone(n.data.params) },
    }
  })
  const usedEdges = [...edgeKeys]
  const edges: FlowEdge[] = clip.edges.map((e) => {
    const source = keyMap.get(e.source) as string
    const target = keyMap.get(e.target) as string
    const params = structuredClone(e.data?.params ?? {})
    for (const field of ['pool', 'hook_pool']) {
      const ref = params[field]
      if (typeof ref === 'string' && keyMap.has(ref)) params[field] = keyMap.get(ref)
    }
    const id = edgeKey(source, target, usedEdges)
    usedEdges.push(id)
    const material = e.data?.material ?? ''
    return { id, source, target, selected: false, data: { material, params }, label: edgeLabel(material, params) }
  })
  return { nodes, edges }
}

/** Bộ nhớ tạm của Editor: giữ khi chuyển sang phiên bản khác, để sao chép node từ sơ đồ này sang sơ đồ kia. */
export const clipboard: { clip: Clip | null; pastes: number } = { clip: null, pastes: 0 }
