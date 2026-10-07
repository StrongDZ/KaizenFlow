export type ConnectResult = { ok: true } | { ok: false; reason: string }

/**
 * Có được nối hai node này bằng một đường nối không. Phần lớn trường hợp sai đã bị chặn vì node không có cổng
 * (Nguồn không có cổng vào, Đích không có cổng ra, đội xe không có cổng nào), hàm này giữ lý do bằng chữ cho lúc người dùng
 * vẫn thả dây vào một node, và chặn nối node với chính nó (React Flow cho phép).
 */
export function canConnect(c: { source?: string | null; target?: string | null }, archetypeOf: (id: string) => string | undefined): ConnectResult {
  if (!c.source || !c.target) return { ok: false, reason: 'Thả dây vào một node để nối.' }
  if (c.source === c.target) return { ok: false, reason: 'Không nối một node với chính nó.' }
  const a = archetypeOf(c.source)
  const b = archetypeOf(c.target)
  if (a === 'RESOURCE_POOL' || b === 'RESOURCE_POOL') {
    return { ok: false, reason: 'Đội xe / người không nối bằng đường nối. Chọn đội xe ở Cách vận chuyển trong thuộc tính của đường nối.' }
  }
  if (a === 'SINK') return { ok: false, reason: 'Đích chỉ nhận hàng, không đưa hàng đi tiếp.' }
  if (b === 'SOURCE') return { ok: false, reason: 'Nguồn chỉ phát hàng, không nhận hàng từ node khác.' }
  return { ok: true }
}
