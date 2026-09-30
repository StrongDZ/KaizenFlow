import type { SubjectSnap } from '../api/types'
import type { Badge } from './graph'
import { MAX_DOTS } from './flow'
import { NO_USE_COVERAGE, colorFor, type Thresholds } from './replay'

/** Quá chừng này (mili giây thực) không nhận được bản tin nào của đối tượng thì coi là mất tín hiệu. */
export const STALE_MS = 15000
export const STALE_TEXT = 'mất tín hiệu'

const STATE_LABEL: Record<string, string> = {
  RUNNING: 'Đang chạy', IDLE: 'Nghỉ', STARVED: 'Thiếu liệu', BLOCKED: 'Tắc đầu ra', DOWN: 'Hỏng',
}
const STATE_COLOR: Record<string, Badge['color']> = {
  RUNNING: 'GREEN', IDLE: 'INFO', STARVED: 'YELLOW', BLOCKED: 'YELLOW', DOWN: 'RED',
}

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state
}

const comma = (x: number, digits = 1) => x.toFixed(digits).replace('.', ',')
const val = (s: SubjectSnap, name: string): number | undefined => s.signals[name]?.v

/** Nhãn hiển thị trên node theo dữ liệu live; undefined khi chưa có dữ liệu nào (node chưa được ghép). */
export function nodeBadge(archetype: string, s: SubjectSnap | undefined, th: Thresholds, poolTotal?: number): Badge | undefined {
  if (!s) return undefined
  if (s.age_ms > STALE_MS) {
    return { color: 'INFO', text: STALE_TEXT, hint: 'Đã lâu không nhận được bản tin nào của thiết bị này, nên không hiện số liệu cũ.' }
  }
  switch (archetype) {
    case 'PROCESS': {
      const ok = val(s, 'count_ok')
      const parts = [s.state ? stateLabel(s.state) : undefined, ok !== undefined ? `${Math.round(ok)} đạt` : undefined].filter(Boolean)
      if (parts.length === 0) return undefined
      return { color: (s.state && STATE_COLOR[s.state]) || 'INFO', text: parts.join(' · '), hint: 'Trạng thái máy nhận từ thiết bị: Đang chạy, Thiếu liệu, Tắc đầu ra hoặc Hỏng.' }
    }
    case 'STORAGE': {
      const cov = val(s, 'coverage_h')
      if (cov !== undefined) {
        const text = cov >= NO_USE_COVERAGE ? 'không tiêu thụ' : `còn ${comma(cov)} giờ`
        return { color: colorFor(cov, th), text, hint: 'Tồn kho đủ dùng thêm chừng này ở tốc độ tiêu thụ trong giờ gần nhất.' }
      }
      const levels = Object.entries(s.signals).filter(([k]) => k.startsWith('level:')).map(([, x]) => x.v)
      if (levels.length === 0) return undefined
      return { color: 'INFO', text: `tồn ${Math.round(levels.reduce((a, b) => a + b, 0))}`, hint: 'Chưa đủ lịch sử để tính số giờ còn dùng được.' }
    }
    case 'SINK': {
      const bo = val(s, 'backorder')
      if (bo === undefined) return undefined
      return bo > 0 ? { color: 'YELLOW', text: `nợ ${Math.round(bo)} đơn` } : { color: 'GREEN', text: 'không nợ đơn' }
    }
    case 'SOURCE': {
      const a = val(s, 'arrived')
      return a === undefined ? undefined : { color: 'INFO', text: `đã nhập ${Math.round(a)}` }
    }
    case 'RESOURCE_POOL': {
      const busy = val(s, 'busy')
      if (busy === undefined) return undefined
      const queue = Math.round(val(s, 'queue_len') ?? 0)
      const total = poolTotal !== undefined ? `/${poolTotal}` : ''
      return { color: 'INFO', text: `${Math.round(busy)}${total} bận, ${queue} chờ` }
    }
  }
  return undefined
}

/** Số hạt trên edge theo lưu lượng (đơn vị/giây) so với mức bận chuẩn; cùng thang với Control Room. */
export function dotsFromRate(rate: number | undefined, peak: number): number {
  if (rate === undefined || rate <= 0 || peak <= 0) return 0
  return Math.min(MAX_DOTS, 1 + Math.round((MAX_DOTS - 1) * (rate / peak)))
}

/** Mức bận chuẩn: tăng ngay khi thấy lưu lượng lớn hơn, giảm rất chậm để số hạt không nhấp nháy. */
export function trackPeak(prev: number, rates: number[]): number {
  return Math.max(prev * 0.995, ...rates)
}

export type Summary = { redStorages: number; yellowStorages: number; downMachines: number; stale: number; silent: number }

/** Đếm nhanh cho dải tóm tắt: bao nhiêu kho Đỏ/Vàng, máy hỏng, thiết bị mất tín hiệu, node chưa nhận dữ liệu. */
export function summarize(items: { archetype: string; badge: Badge | undefined }[]): Summary {
  const out: Summary = { redStorages: 0, yellowStorages: 0, downMachines: 0, stale: 0, silent: 0 }
  for (const { archetype, badge } of items) {
    if (!badge) { out.silent++; continue }
    if (badge.text === STALE_TEXT) { out.stale++; continue }
    if (archetype === 'STORAGE' && badge.color === 'RED') out.redStorages++
    else if (archetype === 'STORAGE' && badge.color === 'YELLOW') out.yellowStorages++
    else if (archetype === 'PROCESS' && badge.color === 'RED') out.downMachines++
  }
  return out
}
