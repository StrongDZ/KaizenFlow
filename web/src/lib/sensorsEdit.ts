import type { Json } from '../api/types'
import { setKind } from './dist'

/** Kiểu ảnh hưởng của một chế độ hỏng lên tín hiệu cảm biến (đúng tập EFFECT_KINDS của sim). */
export const EFFECT_LABEL: Record<string, string> = {
  ramp: 'Tăng dần đều',
  exp: 'Tăng dần theo hàm mũ (càng gần hỏng càng nhanh)',
  step: 'Nhảy lên một bậc',
  spike: 'Đột biến từng lúc',
  freeze: 'Đứng yên (cảm biến kẹt)',
  zero: 'Về 0',
}
export const EFFECT_KINDS = Object.keys(EFFECT_LABEL)

/** Cảm biến mới: điền sẵn tần số và giá trị nền để người dùng thấy cần nhập gì. */
export function newSignal(): Json {
  return { name: '', unit: '', hz: 1, base: setKind(1, 'norm') }
}

/** Chế độ hỏng mới: suy giảm kiểu hao mòn, vài giờ từ suy giảm đến hỏng, rồi máy dừng (DOWN) và sửa mất khoảng một giờ. */
export function newFailureMode(): Json {
  return {
    code: '',
    onset: { dist: 'weibull', shape: 2, scale: 604800 },
    p_to_f: { dist: 'tri', min: 3600, mode: 5400, max: 7200 },
    effects: [],
    on_fail: { state: 'DOWN', mttr: { dist: 'lognorm', mean: 3600, cv: 0.3 } },
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Những chỗ chưa ổn của danh sách cảm biến, bằng tiếng Việt, nói rõ dòng nào. */
export function signalProblems(list: Json[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  list.forEach((s, i) => {
    const name = str(s.name)
    if (name === '') out.push(`Cảm biến ở dòng ${i + 1} chưa có tên.`)
    else if (seen.has(name)) out.push(`Hai cảm biến cùng tên "${name}" (trùng).`)
    seen.add(name)
    const label = name === '' ? `dòng ${i + 1}` : `"${name}"`
    if (typeof s.hz !== 'number' || !(s.hz > 0)) out.push(`Cảm biến ${label}: tần số lấy mẫu phải lớn hơn 0.`)
    if (s.base === undefined || s.base === null) out.push(`Cảm biến ${label}: chưa có giá trị nền.`)
  })
  return out
}

/** Những chỗ chưa ổn của danh sách chế độ hỏng; sensors là tên các cảm biến hiện có (ảnh hưởng chỉ trỏ tới những cái này). */
export function failureProblems(list: Json[], sensors: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  list.forEach((m, i) => {
    const code = str(m.code)
    if (code === '') out.push(`Chế độ hỏng ở dòng ${i + 1} chưa có mã.`)
    else if (seen.has(code)) out.push(`Hai chế độ hỏng cùng mã "${code}" (trùng).`)
    seen.add(code)
    const label = code === '' ? `dòng ${i + 1}` : `"${code}"`
    if (m.onset === undefined || m.onset === null) out.push(`Chế độ hỏng ${label}: chưa đặt thời điểm bắt đầu suy giảm.`)
    if (m.p_to_f === undefined || m.p_to_f === null) out.push(`Chế độ hỏng ${label}: chưa đặt thời gian từ suy giảm đến hỏng.`)
    const effects = Array.isArray(m.effects) ? (m.effects as Json[]) : []
    for (const e of effects) {
      if (!sensors.includes(str(e.signal))) out.push(`Chế độ hỏng ${label}: ảnh hưởng trỏ tới cảm biến "${str(e.signal)}" không có trong danh sách cảm biến.`)
      if (!EFFECT_KINDS.includes(str(e.kind))) out.push(`Chế độ hỏng ${label}: kiểu ảnh hưởng "${str(e.kind)}" không hợp lệ.`)
    }
  })
  return out
}

/** Thêm một ảnh hưởng mặc định (tăng dần đều, 3 lần độ lệch chuẩn) lên một cảm biến. */
export function withEffect(m: Json, signal: string): Json {
  const effects = Array.isArray(m.effects) ? (m.effects as Json[]) : []
  return { ...m, effects: [...effects, { signal, kind: 'ramp', mag_sd: 3 }] }
}

export function withoutEffect(m: Json, index: number): Json {
  const effects = Array.isArray(m.effects) ? (m.effects as Json[]) : []
  return { ...m, effects: effects.filter((_, i) => i !== index) }
}
