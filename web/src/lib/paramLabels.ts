/**
 * Tên tiếng Việt cho các trường tham số node. Schema built-in (services/api/internal/catalog/schemas.go) chỉ có khoá JSON
 * (`mtbf`, `in_buffer`...), nên form hiện ra chữ kỹ thuật. Tra theo đường dẫn trước (`lots[].qty`), rồi theo tên khoá.
 * Áp cả cho node type tự tạo, vì chúng dùng chung schema theo archetype.
 */
type Label = { title: string; hint?: string }

const LABELS: Record<string, Label> = {
  // Nguồn
  arrivals: { title: 'Lịch hàng đến' },
  interarrival: { title: 'Khoảng cách giữa hai lần hàng đến' },
  schedule_s: { title: 'Các mốc hàng đến (giây kể từ lúc bắt đầu)', hint: 'Dùng thay cho khoảng cách ngẫu nhiên khi biết giờ giao cụ thể.' },
  lots: { title: 'Mỗi lần hàng đến gồm' },
  'lots[].qty': { title: 'Số lượng mỗi lần hàng đến' },
  // Kho
  capacity: { title: 'Sức chứa tổng', hint: 'Tổng số đơn vị kho chứa được, cộng mọi vật tư.' },
  stock: { title: 'Tồn kho theo vật tư' },
  'stock[].initial': { title: 'Tồn ban đầu' },
  'stock[].max': { title: 'Tồn tối đa' },
  coverage_thresholds: { title: 'Ngưỡng cảnh báo', hint: 'Tính theo số giờ hàng còn đủ dùng ở tốc độ tiêu thụ gần đây.' },
  red_h: { title: 'Báo Đỏ khi dưới (giờ)' },
  yellow_low_h: { title: 'Báo Vàng khi dưới (giờ)' },
  yellow_high_h: { title: 'Báo Vàng khi trên (giờ, thừa hàng)' },
  replenish: { title: 'Tự bổ sung hàng' },
  policy: { title: 'Cách bổ sung' },
  rop: { title: 'Điểm đặt hàng lại', hint: 'Tồn xuống mức này thì bổ sung.' },
  'replenish.qty': { title: 'Số lượng mỗi lần bổ sung' },
  coverage_window_s: { title: 'Khoảng tính tốc độ tiêu thụ (giây)', hint: 'Mặc định 3600, tức là một giờ gần nhất.' },
  // Trạm xử lý
  recipes: { title: 'Công thức', hint: 'Mỗi công thức cho biết máy nhận vào gì và làm ra gì trong một chu kỳ.' },
  'recipes[].inputs': { title: 'Nguyên liệu vào' },
  'recipes[].outputs': { title: 'Thành phẩm ra', hint: 'Cổng "Lỗi (NG)" là hàng không đạt.' },
  port: { title: 'Cổng ra' },
  cycle: { title: 'Thời gian chu kỳ', hint: 'Thời gian máy xử lý một lần.' },
  slots: { title: 'Số vị trí chạy song song', hint: 'Số lần xử lý cùng lúc. Mặc định 1.' },
  ng_rate: { title: 'Tỉ lệ hàng lỗi', hint: 'Từ 0 đến 1, ví dụ 0,03 là 3%. Bỏ trống là không có hàng lỗi.' },
  in_buffer: { title: 'Sức chứa đầu vào', hint: 'Số đơn vị mỗi vật tư máy giữ trước khi chạy.' },
  out_buffer: { title: 'Sức chứa đầu ra', hint: 'Đầy thì máy dừng chờ.' },
  mtbf: { title: 'Thời gian giữa hai lần hỏng ngẫu nhiên (MTBF)', hint: 'Không đặt thì dùng mặc định của loại node (thường là không hỏng ngẫu nhiên).' },
  mttr: { title: 'Thời gian sửa mỗi lần hỏng (MTTR)' },
  signals: { title: 'Cảm biến', hint: 'Tín hiệu máy phát ra, dùng để tạo dữ liệu cho bảo trì dự đoán.' },
  'signals[].name': { title: 'Tên tín hiệu' },
  'signals[].hz': { title: 'Tần số lấy mẫu (Hz)' },
  failure_modes: { title: 'Chế độ hỏng' },
  'failure_modes[].code': { title: 'Mã chế độ hỏng' },
  // Đích
  buffer: { title: 'Sức chứa' },
  throughput: { title: 'Tính vào sản lượng' },
  demand: { title: 'Nhu cầu (khách lấy hàng)' },
  'demand[].kind': { title: 'Kiểu nhu cầu' },
  'demand[].qty': { title: 'Số lượng mỗi lần lấy' },
  takt: { title: 'Takt: khoảng cách giữa hai lần lấy hàng' },
  hourly_rate: { title: 'Tốc độ theo giờ (đơn vị mỗi giờ)' },
  forecast_ref: { title: 'Nguồn dự báo' },
  producer: { title: 'Tên nguồn dự báo' },
  // Đội xe / người
  kind: { title: 'Loại' },
  count: { title: 'Số lượng' },
  service: { title: 'Thời gian phục vụ mỗi lượt', hint: 'Xe: thời gian nhận hàng. Người: thời gian móc.' },
  // Dùng chung
  material: { title: 'Vật tư' },
  qty: { title: 'Số lượng' },
  name: { title: 'Tên' },
  code: { title: 'Mã' },
  dist: { title: 'Kiểu giá trị' },
}

const ENUMS: Record<string, Record<string, string>> = {
  port: { OK: 'Đạt (OK)', NG: 'Lỗi (NG)' },
  policy: { NONE: 'Không bổ sung', REORDER_POINT: 'Khi tồn xuống điểm đặt hàng lại' },
  'demand[].kind': { TAKT: 'Đều theo takt', FORECAST: 'Theo dự báo' },
  kind: { AGV: 'AGV (băng từ, tuyến cố định)', AMR: 'AMR (tự hành, FMS điều phối)', TUGGER: 'Xe kéo (tugger)', FORKLIFT: 'Xe nâng', OPERATOR: 'Người vận hành' },
}

/**
 * Thứ tự hiện các trường. PostgreSQL jsonb sắp khoá theo độ dài (qty đứng trước material), nên form tự đọc ra thứ tự lộn xộn.
 * Ô đơn hiện trước, nhóm (mảng, đối tượng) hiện sau; trong một dòng thì vật tư đứng trước số lượng.
 */
const ORDER = [
  'kind', 'count', 'service',
  'capacity', 'coverage_window_s', 'buffer', 'throughput', 'cycle', 'slots', 'ng_rate', 'in_buffer', 'out_buffer', 'mtbf', 'mttr',
  'arrivals', 'lots', 'recipes', 'stock', 'coverage_thresholds', 'replenish', 'demand', 'signals', 'failure_modes',
  'interarrival', 'schedule_s', 'inputs', 'outputs', 'material', 'qty', 'initial', 'max', 'port', 'name', 'hz', 'code', 'takt', 'hourly_rate',
  'forecast_ref', 'producer', 'red_h', 'yellow_low_h', 'yellow_high_h', 'policy', 'rop',
]
const ORDER_AT: Record<string, string[]> = { replenish: ['policy', 'rop', 'qty'] }

function ordered(props: Obj, path: string): [string, unknown][] {
  const rank = ORDER_AT[path] ?? ORDER
  const at = (k: string) => { const i = rank.indexOf(k); return i === -1 ? rank.length : i }
  return Object.entries(props).sort(([a], [b]) => at(a) - at(b))
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function walk(node: unknown, path: string, key: string, branch: boolean): unknown {
  if (!isObj(node)) return node
  const out: Obj = { ...node }
  const label = LABELS[path] ?? LABELS[key]
  if (label && !branch) {
    if (out.title === undefined) out.title = label.title
    if (label.hint && out.description === undefined) out.description = label.hint
  }
  const names = ENUMS[path] ?? ENUMS[key]
  if (names && Array.isArray(out.enum) && out.oneOf === undefined) {
    const values = out.enum as string[]
    delete out.enum
    if (out.type === undefined) out.type = 'string'
    out.oneOf = values.map((v) => ({ const: v, title: names[v] ?? v }))
  }
  if (isObj(out.properties)) {
    out.properties = Object.fromEntries(
      ordered(out.properties, path).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k, k, false)]),
    )
  }
  if (out.items !== undefined) out.items = walk(out.items, `${path}[]`, key, true)
  for (const k of ['allOf', 'anyOf'] as const) {
    if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map((b) => walk(b, path, key, true))
  }
  if (Array.isArray(out.oneOf) && !names) out.oneOf = (out.oneOf as unknown[]).map((b) => walk(b, path, key, true))
  if (isObj(out.$defs)) {
    out.$defs = Object.fromEntries(Object.entries(out.$defs).map(([k, v]) => [k, walk(v, `$defs.${k}`, k, true)]))
  }
  return out
}

/** Trả bản sao của schema với tiêu đề, gợi ý và tên giá trị liệt kê bằng tiếng Việt; không sửa schema gốc. */
export function labelSchema(schema: unknown): unknown {
  return walk(schema, '', '', true)
}
