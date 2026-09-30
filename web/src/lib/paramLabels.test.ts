import { describe, expect, it } from 'vitest'
import { labelSchema } from './paramLabels'

type S = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const process: S = {
  type: 'object',
  properties: {
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { $ref: '#/$defs/line' } },
          outputs: { type: 'array', items: { allOf: [{ $ref: '#/$defs/line' }, { properties: { port: { enum: ['OK', 'NG'] } } }] } },
        },
      },
    },
    mtbf: { $ref: '#/$defs/dist' },
    in_buffer: { type: 'number' },
    ng_rate: { type: 'number' },
  },
  $defs: { line: { type: 'object', properties: { material: { type: 'string' }, qty: { type: 'number' } } }, dist: {} },
}

describe('labelSchema', () => {
  const out = labelSchema(process) as S
  it('gives plain-language Vietnamese titles at every depth, through refs and allOf', () => {
    expect(out.properties.recipes.title).toBe('Công thức')
    expect(out.properties.recipes.items.properties.inputs.title).toBe('Nguyên liệu vào')
    expect(out.properties.recipes.items.properties.outputs.title).toBe('Thành phẩm ra')
    expect(out.properties.in_buffer.title).toBe('Sức chứa đầu vào')
    expect(out.$defs.line.properties.material.title).toBe('Vật tư')
    expect(out.$defs.line.properties.qty.title).toBe('Số lượng')
    expect(out.properties.recipes.items.properties.outputs.items.allOf[1].properties.port.title).toBe('Cổng ra')
  })
  it('adds a short hint only where the field is not self-explanatory', () => {
    expect(out.properties.ng_rate.description).toMatch(/0,03/)
    expect(out.properties.recipes.items.properties.inputs.description).toBeUndefined()
  })
  it('shows enum values by name instead of code', () => {
    const port = out.properties.recipes.items.properties.outputs.items.allOf[1].properties.port
    expect(port.enum).toBeUndefined()
    expect(port.oneOf).toEqual([{ const: 'OK', title: 'Đạt (OK)' }, { const: 'NG', title: 'Lỗi (NG)' }])
  })
  it('does not override a title the schema already has, and does not mutate its input', () => {
    const own = labelSchema({ type: 'object', properties: { in_buffer: { type: 'number', title: 'Của tôi' } } }) as S
    expect(own.properties.in_buffer.title).toBe('Của tôi')
    expect(process.properties.in_buffer.title).toBeUndefined()
    expect(process.properties.recipes.items.properties.outputs.items.allOf[1].properties.port.enum).toEqual(['OK', 'NG'])
  })
  it('titles the same key differently depending on where it sits', () => {
    const s = labelSchema({
      type: 'object',
      properties: {
        lots: { type: 'array', items: { type: 'object', properties: { qty: { type: 'number' } } } },
        demand: { type: 'array', items: { type: 'object', properties: { qty: { type: 'number' }, kind: { enum: ['TAKT', 'FORECAST'] } } } },
        kind: { enum: ['AGV', 'TUGGER'] },
        replenish: { type: 'object', properties: { qty: { type: 'integer' } } },
      },
    }) as S
    expect(s.properties.lots.items.properties.qty.title).toBe('Số lượng mỗi lần hàng đến')
    expect(s.properties.demand.items.properties.qty.title).toBe('Số lượng mỗi lần lấy')
    expect(s.properties.replenish.properties.qty.title).toBe('Số lượng mỗi lần bổ sung')
    expect(s.properties.demand.items.properties.kind.oneOf[0].title).toBe('Đều theo takt')
    expect(s.properties.kind.oneOf.map((o: S) => o.title)).toEqual(['AGV', 'Xe kéo (tugger)'])
  })
  it('orders fields for reading, whatever order jsonb stored them in: single fields before groups, material before quantity', () => {
    const s = labelSchema({
      type: 'object',
      properties: {
        recipes: { type: 'array', items: { type: 'object', properties: { outputs: { type: 'array' }, inputs: { type: 'array' } } } },
        ng_rate: { type: 'number' },
        slots: { type: 'integer' },
        cycle: { type: 'number' },
        zzz_custom: { type: 'number' },
        lots: { type: 'array', items: { type: 'object', properties: { qty: { type: 'number' }, material: { type: 'string' } } } },
        replenish: { type: 'object', properties: { qty: { type: 'integer' }, rop: { type: 'number' }, policy: { type: 'string' } } },
      },
    }) as S
    expect(Object.keys(s.properties)).toEqual(['cycle', 'slots', 'ng_rate', 'lots', 'recipes', 'replenish', 'zzz_custom'])
    expect(Object.keys(s.properties.lots.items.properties)).toEqual(['material', 'qty'])
    expect(Object.keys(s.properties.recipes.items.properties)).toEqual(['inputs', 'outputs'])
    expect(Object.keys(s.properties.replenish.properties)).toEqual(['policy', 'rop', 'qty'])
  })
  it('leaves keys it does not know alone rather than inventing a label', () => {
    const s = labelSchema({ type: 'object', properties: { zzz_custom: { type: 'number' } } }) as S
    expect(s.properties.zzz_custom.title).toBeUndefined()
  })
})

// Mọi đường dẫn tham số của bộ schema built-in (services/api/internal/catalog/schemas.go) phải có tên tiếng Việt.
describe('coverage of the built-in catalog', () => {
  const paths = [
    'arrivals', 'arrivals.interarrival', 'arrivals.schedule_s', 'lots', 'lots[].material', 'lots[].qty',
    'capacity', 'stock', 'stock[].material', 'stock[].initial', 'stock[].max', 'coverage_thresholds', 'coverage_thresholds.red_h',
    'coverage_thresholds.yellow_low_h', 'coverage_thresholds.yellow_high_h', 'replenish', 'replenish.policy', 'replenish.rop',
    'replenish.qty', 'coverage_window_s', 'recipes', 'recipes[].inputs', 'recipes[].outputs', 'recipes[].inputs[].material',
    'recipes[].inputs[].qty', 'recipes[].outputs[].port', 'cycle', 'slots', 'ng_rate', 'in_buffer', 'out_buffer', 'mtbf', 'mttr',
    'signals', 'signals[].name', 'signals[].hz', 'failure_modes', 'failure_modes[].code', 'buffer', 'throughput', 'demand',
    'demand[].kind', 'demand[].material', 'demand[].qty', 'demand[].takt', 'demand[].hourly_rate', 'demand[].forecast_ref',
    'demand[].forecast_ref.producer', 'kind', 'count', 'service',
  ]
  /** Dựng schema lồng nhau theo đường dẫn rồi đọc lại tiêu đề của lá. */
  function titleAt(path: string): unknown {
    const steps = path.split('.').flatMap((seg) => (seg.endsWith('[]') ? [{ key: seg.slice(0, -2), array: true }] : [{ key: seg, array: false }]))
    let node: S = { type: 'number' }
    for (let i = steps.length - 1; i >= 0; i--) {
      const prop: S = steps[i].array ? { type: 'array', items: i === steps.length - 1 ? { type: 'number' } : node } : node
      node = { type: 'object', properties: { [steps[i].key]: prop } }
    }
    let cur: S = labelSchema(node) as S
    let title: unknown
    for (const st of steps) {
      const prop: S = cur.properties[st.key]
      title = prop.title
      cur = st.array ? prop.items : prop
    }
    return title
  }
  it.each(paths)('%s has a title', (path) => {
    expect(titleAt(path), path).toMatch(/\S/)
  })
})
