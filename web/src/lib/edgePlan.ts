import type { Binding, BindingInput, PlannedEdge } from '../api/types'

/** Các đường nối đang chạy bằng số ước lượng (moved tự tính đánh dấu ước lượng, đang bật): hiện nét đứt trên sơ đồ. */
export function estimatedEdges(bindings: Binding[]): Set<string> {
  return new Set(bindings.filter((b) => b.enabled && b.signal === 'moved' && b.mode === 'derived' && b.derive?.estimate === true).map((b) => b.subject))
}

/** Kế hoạch tự suy thành ghép nối để lưu một lượt: công thức tham chiếu lẫn nhau nên phải lưu đủ bộ. */
export function planBindings(items: PlannedEdge[]): BindingInput[] {
  return items.map((i) => ({ subject: i.subject, signal: i.signal, mode: 'derived', enabled: true, derive: i.derive }))
}
