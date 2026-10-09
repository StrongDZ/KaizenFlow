import type { NodeRow } from './nodeSummary'

const int = (x: number) => Math.round(x).toLocaleString('vi-VN')
const sumOf = (v: Record<string, number>, prefix: string): number | undefined => {
  const keys = Object.keys(v).filter((k) => k.startsWith(prefix))
  return keys.length === 0 ? undefined : keys.reduce((s, k) => s + v[k], 0)
}

/**
 * Số đo của một node tại thời điểm đang xem khi phát lại lần chạy (trung vị qua các lần lặp), thành tối đa hai dòng cho thẻ node.
 * `v`: chỉ số của node tại thời điểm đó (count_ok, in:PART, level:RAW-01…). Mức tồn so với ngưỡng nằm ở dòng trạng thái, không ở đây.
 */
export function runRows(archetype: string, v: Record<string, number>, opts: { poolCount?: number; maxStock?: number } = {}): NodeRow[] {
  const out: NodeRow[] = []
  switch (archetype) {
    case 'STORAGE': {
      const level = sumOf(v, 'level:')
      if (level !== undefined) out.push({ label: 'Tồn', value: opts.maxStock ? `${int(level)} / ${int(opts.maxStock)}` : int(level) })
      break
    }
    case 'PROCESS': {
      const queue = sumOf(v, 'in:')
      if (queue !== undefined) out.push({ label: 'Chờ vào', value: int(queue) })
      if (v.count_ok !== undefined) out.push({ label: 'Đã làm', value: int(v.count_ok) })
      break
    }
    case 'SINK': {
      if (v.demand) {
        if (v.fulfilled !== undefined) out.push({ label: 'Đã giao', value: `${int(v.fulfilled)} / ${int(v.demand)}` })
        if (v.backorder !== undefined) out.push({ label: 'Nợ đơn', value: int(v.backorder), tone: v.backorder >= 0.5 ? 'warn' : undefined })
      } else if (v.fulfilled !== undefined) {
        out.push({ label: 'Đã nhận', value: int(v.fulfilled) })
      }
      break
    }
    case 'SOURCE': {
      const arrived = sumOf(v, 'arrived')
      if (arrived !== undefined) out.push({ label: 'Đã nhập', value: int(arrived) })
      break
    }
    case 'RESOURCE_POOL': {
      if (v.busy !== undefined) out.push({ label: 'Đang bận', value: opts.poolCount ? `${int(v.busy)} / ${int(opts.poolCount)}` : int(v.busy) })
      if (v.queue_len !== undefined) out.push({ label: 'Lượt chờ', value: int(v.queue_len), tone: v.queue_len >= 0.5 ? 'warn' : undefined })
      break
    }
  }
  return out
}
