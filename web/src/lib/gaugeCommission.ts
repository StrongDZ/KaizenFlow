// Logic thuần của màn khai báo theo camera: toạ độ con trỏ thành toạ độ khung hình, dựng config của một đồng hồ,
// sửa config của máy. Quy tắc ở đây khớp với phần kiểm tra của config-api (validate.go).

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

/** Một đồng hồ trong config của máy (config.proto: Gauge), chỉ khai những trường màn này đọc; trường khác được giữ nguyên. */
export type GaugeDoc = {
  gauge_id: string
  type: string
  unit?: string
  roi: number[]
  camera_id?: string
  calib?: Record<string, unknown>
  rules?: Record<string, unknown>
  [key: string]: unknown
}

export type StationConfigDoc = {
  machine_id: string
  plant: string
  line: string
  window_sec: number
  gauges: GaugeDoc[]
  [key: string]: unknown
}

export type StationDoc = { machine_id: string; config: StationConfigDoc }

/** Điểm trên ảnh đang hiển thị thành pixel của khung hình gốc, không vượt ra ngoài khung. */
export function toFrame(p: Point, shown: Size, frame: Size): Point {
  const clamp = (v: number, max: number) => Math.min(Math.max(Math.round(v), 0), max)
  return { x: clamp((p.x * frame.width) / shown.width, frame.width), y: clamp((p.y * frame.height) / shown.height, frame.height) }
}

/** Vùng nhỏ hơn mức này (pixel khung hình) coi như bấm nhầm, không phải khoanh vùng. */
const MIN_ROI = 12

/** Hai đầu của một lần kéo chuột thành roi [x, y, rộng, cao] theo pixel khung hình. */
export function dragToRoi(a: Point, b: Point, shown: Size, frame: Size): number[] | null {
  const p = toFrame(a, shown, frame), q = toFrame(b, shown, frame)
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y)
  const w = Math.abs(p.x - q.x), h = Math.abs(p.y - q.y)
  return w < MIN_ROI || h < MIN_ROI ? null : [x, y, w, h]
}

/** Cạnh hình vuông mà vùng đọc được kéo giãn về trước khi giải mã (rect_size mặc định). */
const RECT = 256

/** Điểm trên khung hình thành toạ độ calib: trong hình vuông 256 mà roi được kéo giãn về (đồng hồ nhìn thẳng, không có quad). */
export function calibPoint(p: Point, roi: number[]): [number, number] {
  const round = (v: number) => Math.round(v * 10) / 10
  return [round(((p.x - roi[0]) * RECT) / roi[2]), round(((p.y - roi[1]) * RECT) / roi[3])]
}

export type GaugeType = 'analog_dial' | 'seg7' | 'timer_mmss' | 'rolling_counter'

/** Form của một đồng hồ đang khai. Số để dạng chuỗi như người dùng gõ. */
export type GaugeDraft = {
  gauge_id: string
  type: GaugeType
  unit: string
  roi: number[] | null
  center: [number, number] | null
  min_pt: [number, number] | null
  max_pt: [number, number] | null
  min_val: string
  max_val: string
  sweep: 'cw' | 'ccw'
  digits: string
  decimal_pos: string
  color: 'red_led' | 'green_led' | 'lcd'
  decimal_digits: string
  rule_min: string
  rule_max: string
}

export function emptyDraft(type: GaugeType): GaugeDraft {
  return {
    gauge_id: '', type, unit: '', roi: null, center: null, min_pt: null, max_pt: null, min_val: '0', max_val: '', sweep: 'cw',
    digits: type === 'rolling_counter' ? '6' : '4', decimal_pos: '0', color: 'red_led', decimal_digits: '0', rule_min: '', rule_max: '',
  }
}

const ID = /^[A-Za-z0-9_.-]{1,64}$/
const num = (s: string): number | null => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s))

/** Dựng config của đồng hồ từ form. Còn thiếu gì thì trả về danh sách việc phải làm, không trả về đồng hồ. */
export function buildGauge(d: GaugeDraft, cameraId: string): { gauge?: GaugeDoc; problems: string[] } {
  const problems: string[] = []
  if (!ID.test(d.gauge_id)) problems.push('Mã đồng hồ chỉ gồm chữ, số, dấu _ . - (tối đa 64 ký tự).')
  if (!d.roi) problems.push('Chưa khoanh vùng đồng hồ trên ảnh.')
  let calib: Record<string, unknown> = {}
  const rules: Record<string, unknown> = {}
  if (d.type === 'analog_dial') {
    if (!d.center || !d.min_pt || !d.max_pt) problems.push('Chưa chấm đủ ba điểm: tâm, vạch min, vạch max.')
    const lo = num(d.min_val), hi = num(d.max_val)
    if (lo === null || hi === null || lo >= hi) problems.push('Giá trị min phải nhỏ hơn giá trị max.')
    calib = { center: d.center, min_pt: d.min_pt, max_pt: d.max_pt, min_val: lo, max_val: hi, sweep: d.sweep, scale: 'linear' }
  } else if (d.type === 'timer_mmss') {
    calib = { digits: 4, colon_after: 2 }
  } else {
    const digits = num(d.digits)
    const most = d.type === 'seg7' ? 8 : 10
    if (digits === null || !Number.isInteger(digits) || digits < 1 || digits > most) problems.push(`Số chữ số phải từ 1 đến ${most}.`)
    else if (d.type === 'seg7') {
      const pos = num(d.decimal_pos)
      if (pos === null || !Number.isInteger(pos) || pos < 0 || pos > digits) problems.push('Vị trí dấu chấm phải từ 0 đến số chữ số.')
      calib = { digits, decimal_pos: pos, color: d.color }
    } else {
      const dec = num(d.decimal_digits) ?? 0
      if (!Number.isInteger(dec) || dec < 0 || dec >= digits) problems.push('Số chữ số thập phân phải nhỏ hơn số chữ số.')
      calib = { digits, decimal_digits: dec }
      // Bộ đếm giờ chỉ tăng: edge loại số đọc bị lùi.
      rules.monotonic = true
    }
  }
  const lo = num(d.rule_min), hi = num(d.rule_max)
  if (lo !== null && hi !== null && lo >= hi) problems.push('Ngưỡng dưới phải nhỏ hơn ngưỡng trên.')
  if (lo !== null) rules.min = lo
  if (hi !== null) rules.max = hi
  if (problems.length > 0 || !d.roi) return { problems }
  const gauge: GaugeDoc = { gauge_id: d.gauge_id, type: d.type, unit: d.unit.trim(), roi: d.roi, camera_id: cameraId, calib }
  if (Object.keys(rules).length > 0) gauge.rules = rules
  return { gauge, problems }
}

/** Thêm đồng hồ vào config của máy, hoặc thay đồng hồ cùng mã. Máy chưa có config thì tạo config mới. */
export function upsertGauge(
  config: StationConfigDoc | null, machine: { machine_id: string; plant: string; line: string }, gauge: GaugeDoc,
): StationConfigDoc {
  if (!config) return { ...machine, window_sec: 1, gauges: [gauge] }
  const at = config.gauges.findIndex((g) => g.gauge_id === gauge.gauge_id)
  const gauges = at < 0 ? [...config.gauges, gauge] : config.gauges.map((g, i) => (i === at ? gauge : g))
  return { ...config, gauges }
}

export function removeGauge(config: StationConfigDoc, gaugeId: string): StationConfigDoc {
  return { ...config, gauges: config.gauges.filter((g) => g.gauge_id !== gaugeId) }
}

/** Mọi đồng hồ, của mọi máy, đang nằm trên một camera; xếp theo máy rồi theo thứ tự trong config. */
export function gaugesOnCamera(stations: StationDoc[], cameraId: string): { machine_id: string; gauge: GaugeDoc }[] {
  return [...stations]
    .sort((a, b) => a.machine_id.localeCompare(b.machine_id))
    .flatMap((s) => s.config.gauges.filter((g) => g.camera_id === cameraId).map((gauge) => ({ machine_id: s.machine_id, gauge })))
}

/** Màu của từng máy trên ảnh camera: khác nhau cả sắc lẫn độ sáng để phân biệt được khi mù màu. */
const MACHINE_COLORS = ['#c6f432', '#5ee6d0', '#ffb454', '#b79cff', '#ff8fb1', '#7fb2ff']
export function machineColor(index: number): string {
  return MACHINE_COLORS[index % MACHINE_COLORS.length]
}

const str = (v: unknown, fallback: string): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : fallback)
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? [v[0] as number, v[1] as number] : null

/** Nạp một đồng hồ đã lưu vào form để sửa. */
export function draftFromGauge(g: GaugeDoc): GaugeDraft {
  const type = (['analog_dial', 'seg7', 'timer_mmss', 'rolling_counter'] as const).find((t) => t === g.type) ?? 'analog_dial'
  const calib = g.calib ?? {}, rules = g.rules ?? {}
  const base = emptyDraft(type)
  return {
    ...base,
    gauge_id: g.gauge_id, unit: g.unit ?? '', roi: g.roi.length === 4 ? g.roi : null,
    center: pair(calib.center), min_pt: pair(calib.min_pt), max_pt: pair(calib.max_pt),
    min_val: str(calib.min_val, base.min_val), max_val: str(calib.max_val, base.max_val),
    sweep: calib.sweep === 'ccw' ? 'ccw' : 'cw',
    digits: str(calib.digits, base.digits), decimal_pos: str(calib.decimal_pos, base.decimal_pos),
    color: calib.color === 'green_led' || calib.color === 'lcd' ? calib.color : 'red_led',
    decimal_digits: str(calib.decimal_digits, base.decimal_digits),
    rule_min: str(rules.min, ''), rule_max: str(rules.max, ''),
  }
}

/** Đồng hồ sau khi sửa: giữ các trường form không quản lý (quad, deadband...) khi vùng đọc không đổi.
    Vùng đọc đổi thì quad cũ không còn đúng nên bỏ, coi như đồng hồ nhìn thẳng trong vùng mới. */
export function mergeGauge(original: GaugeDoc | undefined, built: GaugeDoc): GaugeDoc {
  if (!original || original.roi.join() !== built.roi.join()) return built
  return { ...original, ...built, calib: { ...original.calib, ...built.calib }, rules: built.rules ? { ...original.rules, ...built.rules } : original.rules }
}

/** Toạ độ calib (trong hình vuông 256) ngược về pixel khung hình, để vẽ điểm đã chấm lên ảnh. */
export function calibToFrame(p: [number, number], roi: number[]): Point {
  return { x: roi[0] + (p[0] * roi[2]) / RECT, y: roi[1] + (p[1] * roi[3]) / RECT }
}
