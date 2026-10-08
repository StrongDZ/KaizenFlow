import type { Json, NodeType } from '../api/types'
import { distMean, formatSeconds, type Tone } from './nodeFacts'

/** Một dòng trong thân thẻ node trên sơ đồ: nhãn bên trái, giá trị bên phải. Thẻ chỉ hiện vài dòng trọng yếu. */
export type NodeRow = { label: string; value: string; tone?: Tone }

/** Số dòng tối đa trong thân thẻ: đủ để biết node làm gì, không thành bảng thông số. */
export const MAX_ROWS = 2

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const int = (x: number) => Math.round(x).toLocaleString('vi-VN')
const lines = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x)) : [])

/** Tham số hiệu lực: của node, thiếu thì lấy mặc định của loại node. */
export function effectiveParams(params: Json, type: NodeType | undefined): Json {
  return { ...(type?.default_params ?? {}), ...params }
}

/** "~45 giây" cho thời gian ngẫu nhiên, "45 giây" cho thời gian cố định. */
function duration(d: unknown): string | undefined {
  if (typeof d === 'number') return formatSeconds(d)
  const mean = distMean(d)
  if (mean === undefined) return undefined
  const fixed = typeof d === 'object' && d !== null && (d as Json).dist === 'const'
  return `${fixed ? '' : '~'}${formatSeconds(mean)}`
}

/** "2 PART" hoặc "PART" khi số lượng là 1; nhiều vật tư nối bằng " + ". */
function recipeSide(list: Json[]): string {
  return list.map((l) => `${num(l.qty) !== undefined && num(l.qty) !== 1 ? `${num(l.qty)} ` : ''}${String(l.material ?? '?')}`).join(' + ')
}

const POOL_UNIT: Record<string, string> = { OPERATOR: 'người', TUGGER: 'xe kéo', FORKLIFT: 'xe nâng', AGV: 'AGV', AMR: 'AMR' }

function materials(list: string[], max = 2): string {
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max}`
}

/** Thông số trọng yếu của node ở bước thiết kế (đã gộp mặc định của loại): mỗi vai trò chọn đúng hai điều người lập kế hoạch cần thấy. */
export function designRows(archetype: string, p: Json): NodeRow[] {
  const out: NodeRow[] = []
  const push = (label: string, value: string | undefined) => { if (value) out.push({ label, value }) }
  switch (archetype) {
    case 'SOURCE': {
      const lots = lines(p.lots)
      if (lots.length > 0) push('Mỗi lô', lots.length === 1 ? `${int(num(lots[0].qty) ?? 1)} ${String(lots[0].material)}` : materials(lots.map((l) => String(l.material))))
      push('Cách nhau', duration((p.arrivals as Json | undefined)?.interarrival))
      break
    }
    case 'STORAGE': {
      const stock = lines(p.stock)
      if (stock.length > 0) {
        const initial = stock.reduce((s, x) => s + (num(x.initial) ?? 0), 0)
        const maxes = stock.map((x) => num(x.max))
        const max = maxes.every((m) => m !== undefined) ? maxes.reduce((s: number, m) => s + (m as number), 0) : undefined
        push('Tồn đầu', max !== undefined ? `${int(initial)} / ${int(max)}` : int(initial))
        push('Vật tư', materials(stock.map((x) => String(x.material))))
      } else if (num(p.capacity) !== undefined) {
        push('Sức chứa', int(num(p.capacity)!))
      }
      break
    }
    case 'PROCESS': {
      push('Chu kỳ', duration(p.cycle))
      const recipe = lines(p.recipes)[0]
      if (recipe) {
        const ins = recipeSide(lines(recipe.inputs))
        const outs = recipeSide(lines(recipe.outputs).filter((o) => o.port !== 'NG'))
        if (ins || outs) push('Công thức', `${ins || '?'} → ${outs || '?'}`)
      }
      if (out.length < MAX_ROWS && num(p.slots) !== undefined) push('Song song', `${int(num(p.slots)!)} vị trí`)
      break
    }
    case 'SINK': {
      const demand = lines(p.demand)[0]
      if (demand) {
        const every = duration((demand.takt as Json | undefined) ?? demand.interarrival)
        push('Nhu cầu', every ? `1 ${String(demand.material)} mỗi ${every}` : String(demand.material))
      } else if (p.throughput === false) {
        push('Nhận', 'hàng loại, không tính sản lượng')
      }
      break
    }
    case 'RESOURCE_POOL': {
      const count = num(p.count)
      const kind = String(p.kind ?? '').toUpperCase()
      push('Số lượng', count !== undefined ? `${int(count)} ${POOL_UNIT[kind] ?? (kind || 'xe')}` : undefined)
      push('Mỗi lượt', duration(p.service))
      break
    }
  }
  return out.slice(0, MAX_ROWS)
}
