import type { RJSFSchema } from '@rjsf/utils'
import type { Json } from '../api/types'

export type EdgeForm = {
  material: string
  mode: 'NONE' | 'CONVEYOR' | 'POOL'
  pool?: string
  hook_pool?: string
  lot: number
  travel_s?: number
}

export function edgeToForm(material: string, params: Json): EdgeForm {
  const travel = params.travel as { value?: number; mean?: number } | undefined
  return {
    material,
    mode: (params.mode as EdgeForm['mode'] | undefined) ?? 'NONE',
    pool: params.pool as string | undefined,
    hook_pool: (params.hook_pool as string | undefined) ?? '',
    lot: (params.lot as number | undefined) ?? 1,
    travel_s: travel ? (travel.value ?? travel.mean) : undefined,
  }
}

export function formToEdge(f: EdgeForm, previous: Json = {}): { material: string; params: Json } {
  const params: Json = { ...previous }
  for (const k of ['mode', 'pool', 'hook_pool', 'lot', 'travel']) delete params[k]
  if (f.mode !== 'NONE') params.mode = f.mode
  if (f.mode === 'POOL' && f.pool) params.pool = f.pool
  if (f.mode === 'POOL' && f.hook_pool) params.hook_pool = f.hook_pool
  if (f.lot && f.lot !== 1) params.lot = f.lot
  if (f.travel_s !== undefined && f.travel_s > 0) params.travel = { dist: 'const', value: f.travel_s }
  return { material: f.material, params }
}

export function edgeSchema(materials: string[], pools: string[], operators: string[]): RJSFSchema {
  return {
    type: 'object',
    required: ['material'],
    properties: {
      material: { type: 'string', title: 'Vật tư', enum: materials.length ? materials : [''] },
      mode: { type: 'string', title: 'Vận chuyển', enum: ['NONE', 'CONVEYOR', 'POOL'], default: 'NONE' },
      pool: { type: 'string', title: 'Đội xe (pool)', enum: pools.length ? pools : [''] },
      hook_pool: { type: 'string', title: 'Người móc kéo', enum: ['', ...operators] },
      lot: { type: 'integer', title: 'Số lượng mỗi chuyến', minimum: 1, default: 1 },
      travel_s: { type: 'number', title: 'Thời gian di chuyển (giây)', minimum: 0 },
    },
  }
}
