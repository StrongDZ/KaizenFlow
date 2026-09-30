/**
 * Giá trị "cố định hoặc ngẫu nhiên" của contract sim (services/sim/sim_service/dists.py): hoặc một số, hoặc
 * {dist, ...tham số}. Mỗi kiểu chỉ dùng vài tham số; form chỉ hiện đúng những tham số đó.
 */
export type Kind = 'const' | 'norm' | 'exp' | 'lognorm' | 'tri' | 'uniform' | 'weibull'
export const KINDS: Kind[] = ['const', 'norm', 'exp', 'lognorm', 'tri', 'uniform', 'weibull']

export const KIND_LABEL: Record<Kind, string> = {
  const: 'Cố định',
  norm: 'Chuẩn: dao động quanh trung bình',
  exp: 'Hàm mũ: thời gian chờ ngẫu nhiên',
  lognorm: 'Log-chuẩn: thường ngắn, thỉnh thoảng rất dài',
  tri: 'Tam giác: nhỏ nhất, hay gặp nhất, lớn nhất',
  uniform: 'Đều: mọi giá trị trong khoảng như nhau',
  weibull: 'Weibull: mô hình hao mòn',
}

/** unitless: hệ số không có đơn vị (cv, hình dạng). */
export type ParamDef = { key: string; label: string; unitless?: boolean }

const PARAMS: Record<Kind, ParamDef[]> = {
  const: [{ key: 'value', label: 'Giá trị' }],
  norm: [{ key: 'mean', label: 'Trung bình' }, { key: 'sd', label: 'Độ lệch chuẩn' }],
  exp: [{ key: 'mean', label: 'Trung bình' }],
  lognorm: [{ key: 'mean', label: 'Trung bình' }, { key: 'cv', label: 'Hệ số biến thiên (cv)', unitless: true }],
  tri: [{ key: 'min', label: 'Nhỏ nhất' }, { key: 'mode', label: 'Hay gặp nhất' }, { key: 'max', label: 'Lớn nhất' }],
  uniform: [{ key: 'min', label: 'Nhỏ nhất' }, { key: 'max', label: 'Lớn nhất' }],
  weibull: [{ key: 'shape', label: 'Hình dạng', unitless: true }, { key: 'scale', label: 'Thang' }],
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const r3 = (x: number) => Math.round(x * 1000) / 1000

export function kindOf(v: unknown): Kind | 'empty' | 'unknown' {
  if (v === undefined || v === null) return 'empty'
  if (isNum(v)) return 'const'
  if (!isObj(v)) return 'unknown'
  const d = v.dist === undefined ? 'const' : v.dist === 'normal' ? 'norm' : v.dist
  return (KINDS as unknown[]).includes(d) ? (d as Kind) : 'unknown'
}

export function paramsOf(kind: Kind): ParamDef[] {
  return PARAMS[kind]
}

/** Sim chấp nhận cả `mean` lẫn `mean_s`. */
export function readParam(v: unknown, key: string): number | undefined {
  if (!isObj(v)) return undefined
  const x = v[key] ?? v[`${key}_s`]
  return isNum(x) ? x : undefined
}

function gamma(z: number): number {
  // Lanczos, đủ chính xác cho ước lượng trung bình Weibull.
  const g = 7
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z))
  const x = z - 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a
}

/** Giá trị trung bình sim sẽ dùng (giống mean_of trong sim); không có gì để dựa vào thì là 1. */
export function typicalOf(v: unknown): number {
  const kind = kindOf(v)
  if (kind === 'const') return isNum(v) ? v : (readParam(v, 'value') ?? 1)
  const mean = readParam(v, 'mean')
  const min = readParam(v, 'min')
  const mode = readParam(v, 'mode')
  const max = readParam(v, 'max')
  if (kind === 'tri' && min !== undefined && mode !== undefined && max !== undefined) return (min + mode + max) / 3
  if (kind === 'uniform' && min !== undefined && max !== undefined) return (min + max) / 2
  if (kind === 'weibull') {
    const shape = readParam(v, 'shape')
    const scale = readParam(v, 'scale')
    if (shape && scale) return scale * gamma(1 + 1 / shape)
  }
  return mean ?? 1
}

/** Đổi kiểu, giữ độ lớn cũ và điền đủ mọi tham số kiểu mới cần (thiếu khoá thì sim báo lỗi hợp đồng). */
export function setKind(v: unknown, kind: Kind): number | Obj {
  const m = r3(typicalOf(v))
  switch (kind) {
    case 'const': return m
    case 'norm': return { dist: 'norm', mean: m, sd: r3(m * 0.1) }
    case 'exp': return { dist: 'exp', mean: m }
    case 'lognorm': return { dist: 'lognorm', mean: m, cv: 0.1 }
    case 'tri': return { dist: 'tri', min: r3(m * 0.5), mode: m, max: r3(m * 1.5) }
    case 'uniform': return { dist: 'uniform', min: r3(m * 0.5), max: r3(m * 1.5) }
    case 'weibull': return { dist: 'weibull', shape: 2, scale: m }
  }
}

/** Sửa một tham số, không đụng các tham số khác; xoá ô thì bỏ khoá. */
export function setParam(v: unknown, key: string, value: number | undefined): unknown {
  if (!isObj(v)) return value
  const name = key in v ? key : `${key}_s` in v ? `${key}_s` : key
  const next: Obj = { ...v }
  if (value === undefined) delete next[name]
  else next[name] = value
  return next
}

export function unitFor(field: string): string {
  return field === 'qty' ? 'đơn vị' : 'giây'
}

export function isDistSchema(s: unknown): boolean {
  if (!isObj(s) || !Array.isArray(s.oneOf) || s.oneOf.length < 2) return false
  const [a, b] = s.oneOf as unknown[]
  return isObj(a) && a.type === 'number' && isObj(b) && isObj(b.properties) && 'dist' in b.properties
}

const num = (n: number) => String(n).replace('.', ',')

/** Mô tả một giá trị mặc định bằng lời, để hiện cạnh lựa chọn "Dùng mặc định của loại node". Không hiểu thì trả chuỗi rỗng. */
export function describeDist(v: unknown, unit: string): string {
  const kind = kindOf(v)
  if (kind === 'empty' || kind === 'unknown') return ''
  const r = (key: string) => readParam(v, key)
  const mean = r('mean')
  switch (kind) {
    case 'const': {
      const x = isNum(v) ? v : r('value')
      return x === undefined ? '' : `${num(x)} ${unit}`
    }
    case 'norm': return mean === undefined ? '' : `Chuẩn, trung bình ${num(mean)} ${unit}`
    case 'exp': return mean === undefined ? '' : `Hàm mũ, trung bình ${num(mean)} ${unit}`
    case 'lognorm': return mean === undefined ? '' : `Log-chuẩn, trung bình ${num(mean)} ${unit}`
    case 'tri': {
      const [a, m, b] = [r('min'), r('mode'), r('max')]
      return a === undefined || m === undefined || b === undefined ? '' : `Tam giác, từ ${num(a)} đến ${num(b)} ${unit}, hay gặp nhất ${num(m)}`
    }
    case 'uniform': {
      const [a, b] = [r('min'), r('max')]
      return a === undefined || b === undefined ? '' : `Đều, từ ${num(a)} đến ${num(b)} ${unit}`
    }
    case 'weibull': {
      const [k, scale] = [r('shape'), r('scale')]
      return k === undefined || scale === undefined ? '' : `Weibull, hình dạng ${num(k)}, thang ${num(scale)} ${unit}`
    }
  }
}
