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
  const prevTravel = previous.travel as { value?: number; mean?: number } | undefined
  const prevS = prevTravel ? (prevTravel.value ?? prevTravel.mean) : undefined
  if (prevTravel && f.travel_s === prevS) params.travel = prevTravel // giữ phân phối ngẫu nhiên nếu người dùng không sửa
  else if (f.travel_s !== undefined && f.travel_s > 0) params.travel = { dist: 'const', value: f.travel_s }
  return { material: f.material, params }
}

/**
 * Schema form của một edge. `mode` cho biết cách vận chuyển đang chọn: chỉ khi là POOL mới hiện đội xe và người móc kéo
 * (không truyền mode thì hiện đủ). `names` đổi khoá node thành tên hiển thị trong danh sách chọn.
 */
export function edgeSchema(
  materials: string[], pools: string[], operators: string[],
  opts: { mode?: string; names?: Record<string, string> } = {},
): RJSFSchema {
  const names = opts.names ?? {}
  const nameOf = (id: string) => (names[id] ? `${names[id]} (${id})` : id)
  const showPool = opts.mode === undefined || opts.mode === 'POOL'
  const properties: NonNullable<RJSFSchema['properties']> = {
    material: { type: 'string', title: 'Vật tư chuyển', description: 'Loại hàng đi trên đường nối này.', enum: materials.length ? materials : [''] },
    mode: {
      type: 'string', title: 'Cách vận chuyển', default: 'NONE',
      oneOf: [
        { const: 'NONE', title: 'Chuyển thẳng, không cần xe' },
        { const: 'CONVEYOR', title: 'Băng chuyền' },
        { const: 'POOL', title: 'Bằng xe kéo hoặc AGV (dùng đội xe)' },
      ],
    },
  }
  if (showPool) {
    properties.pool = {
      type: 'string', title: 'Đội xe chở hàng', description: 'Chọn node đội xe (xe kéo, AGV) làm việc trên đường nối này.',
      enum: pools.length ? pools : [''], enumNames: pools.length ? pools.map(nameOf) : ['(chưa có đội xe nào trong sơ đồ)'],
    } as RJSFSchema
    properties.hook_pool = {
      type: 'string', title: 'Người móc kéo (không bắt buộc)', description: 'Người phải móc và tháo xe mỗi lượt. Bỏ trống nếu không cần.',
      enum: ['', ...operators], enumNames: ['Không cần', ...operators.map(nameOf)],
    } as RJSFSchema
  }
  properties.lot = { type: 'integer', title: 'Số lượng mỗi chuyến', description: 'Chở bao nhiêu đơn vị một lần.', minimum: 1, default: 1 }
  properties.travel_s = { type: 'number', title: 'Thời gian đi một chiều (giây)', minimum: 0 }
  return { type: 'object', required: ['material'], properties }
}
