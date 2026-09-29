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
