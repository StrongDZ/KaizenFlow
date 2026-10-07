import type { Json, ScenarioBody } from '../api/types'

export type InjRow = { target: string; failure: string; at_min: number }
export type OvrRow = { target: string; count: number }
export type ScenarioForm = { name: string; hours: number; reps: number; start: string; inj: InjRow[]; ovr: OvrRow[]; extra: Json[] }

export const EMPTY_FORM: ScenarioForm = { name: 'Ca sáng', hours: 4, reps: 20, start: 'WARMUP', inj: [], ovr: [], extra: [] }

type Source = Pick<ScenarioBody, 'name' | 'horizon_s' | 'replications' | 'start_state' | 'injections' | 'overrides'>

const isCount = (o: Json) => o.path === '/count' && typeof o.value === 'number'

export function scenarioToForm(s: Source): ScenarioForm {
  return {
    name: s.name,
    hours: s.horizon_s / 3600,
    reps: s.replications,
    start: s.start_state,
    inj: s.injections.map((i) => ({ target: String(i.target), failure: String(i.failure), at_min: Number(i.at_s) / 60 })),
    ovr: s.overrides.filter(isCount).map((o) => ({ target: String(o.target), count: o.value as number })),
    // override mà form chưa hiểu (đường dẫn khác /count) được giữ nguyên, không mất khi lưu
    extra: s.overrides.filter((o) => !isCount(o)),
  }
}

export function formToScenarioBody(f: ScenarioForm): ScenarioBody {
  return {
    name: f.name.trim(),
    horizon_s: f.hours * 3600,
    replications: f.reps,
    start_state: f.start,
    injections: f.inj.map((i) => ({ target: i.target, failure: i.failure, at_s: i.at_min * 60 })),
    overrides: [...f.ovr.map((o) => ({ target: o.target, path: '/count', value: o.count })), ...f.extra],
  }
}

/** Những chỗ chưa hợp lệ của form scenario, bằng tiếng Việt, nói rõ sửa gì. Rỗng là có thể lưu. */
export function formProblems(f: ScenarioForm): string[] {
  const out: string[] = []
  if (f.name.trim() === '') out.push('Scenario cần một tên.')
  if (!(f.hours > 0)) out.push('Thời lượng phải lớn hơn 0 giờ.')
  if (!(f.reps >= 1) || f.reps > 200) out.push('Số lần lặp Monte Carlo phải từ 1 đến 200.')
  const horizonMin = f.hours * 60
  f.inj.forEach((r, i) => {
    const n = i + 1
    if (r.failure === '') out.push(`Lỗi tiêm ở dòng ${n}: chọn loại lỗi.`)
    if (r.at_min < 0) out.push(`Lỗi tiêm ở dòng ${n}: số phút không được âm.`)
    else if (f.hours > 0 && r.at_min > horizonMin) out.push(`Lỗi tiêm ở dòng ${n}: phút ${r.at_min} nằm sau khi scenario kết thúc (thời lượng ${Math.round(horizonMin)} phút). Chọn số phút nhỏ hơn.`)
  })
  f.ovr.forEach((r, i) => { if (!(r.count >= 1)) out.push(`Thay đổi nguồn lực ở dòng ${i + 1}: số lượng phải ít nhất 1.`) })
  return out
}
