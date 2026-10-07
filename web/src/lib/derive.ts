import type { Derive, DeriveTerm, SubjectView } from '../api/types'

export const DEFAULT_IDLE_S = 60

export function emptyDerive(kind: Derive['kind'], idleAfterS = DEFAULT_IDLE_S): Derive {
  return kind === 'sum' ? { kind: 'sum', const: 0, terms: [] } : { kind: 'activity', idle_after_s: idleAfterS }
}

export const addTerm = (d: Derive): Derive => ({ ...d, terms: [...(d.terms ?? []), { subject: '', signal: '', sign: 1 }] })
export const updateTerm = (d: Derive, i: number, patch: Partial<DeriveTerm>): Derive => ({ ...d, terms: (d.terms ?? []).map((t, j) => (j === i ? { ...t, ...patch } : t)) })
export const removeTerm = (d: Derive, i: number): Derive => ({ ...d, terms: (d.terms ?? []).filter((_, j) => j !== i) })

/** Đủ thông tin để gửi (server kiểm các luật còn lại: đầu vào đã ghép, không vòng…). */
export function isComplete(d: Derive): boolean {
  if (d.kind === 'activity') return !!d.watch && d.watch.subject !== '' && d.watch.signal !== '' && (d.idle_after_s ?? 0) > 0
  const done = (d.terms ?? []).filter((t) => t.subject !== '' && t.signal !== '')
  return done.length > 0 && done.every((t) => (t.factor ?? 1) >= 0)
}

/** Dạng gửi lên server: bỏ số hạng chưa chọn, hệ số 1 và hằng 0. */
export function toInput(d: Derive): Derive {
  if (d.kind === 'activity') return { kind: 'activity', watch: d.watch, idle_after_s: d.idle_after_s }
  const out: Derive = {
    kind: 'sum',
    terms: (d.terms ?? []).filter((t) => t.subject !== '' && t.signal !== '').map((t) => {
      const { factor, ...rest } = t
      return factor !== undefined && factor !== 1 ? { ...rest, factor } : rest
    }),
  }
  if (d.const) out.const = d.const
  return out
}

const fmt = (n: number) => String(Number(n.toFixed(4))).replace('.', ',')

/** Câu đọc được của công thức: "40 + số đã chuyển của A − số đã chuyển của B". */
export function describeDerive(d: Derive, nameOf: (subject: string) => string, labelOf: (subject: string, signal: string) => string): string {
  if (d.kind === 'activity') {
    if (!d.watch || d.watch.subject === '') return 'Chưa chọn tín hiệu nào'
    return `Đang chạy khi ${labelOf(d.watch.subject, d.watch.signal)} của ${nameOf(d.watch.subject)} còn tăng trong ${fmt(d.idle_after_s ?? DEFAULT_IDLE_S)} giây gần nhất, ngược lại là nghỉ`
  }
  const terms = (d.terms ?? []).filter((t) => t.subject !== '' && t.signal !== '')
  if (terms.length === 0) return 'Chưa chọn tín hiệu nào'
  let out = d.const ? fmt(d.const) : ''
  terms.forEach((t, i) => {
    const f = t.factor !== undefined && t.factor !== 1 ? `${fmt(t.factor)} × ` : ''
    const body = `${f}${labelOf(t.subject, t.signal)} của ${nameOf(t.subject)}`
    if (out === '' && i === 0) out = t.sign < 0 ? `−${body}` : body
    else out += ` ${t.sign < 0 ? '−' : '+'} ${body}`
  })
  return out
}

/** Giá trị công thức cộng trừ theo các giá trị hiện tại; undefined nếu thiếu đầu vào (hoặc là kiểu trạng thái). */
export function previewDerive(d: Derive, read: (subject: string, signal: string) => number | undefined): number | undefined {
  if (d.kind !== 'sum') return undefined
  let total = d.const ?? 0
  for (const t of (d.terms ?? []).filter((x) => x.subject !== '' && x.signal !== '')) {
    const v = read(t.subject, t.signal)
    if (v === undefined) return undefined
    total += t.sign * (t.factor ?? 1) * v
  }
  return total
}

/**
 * Những đối tượng mà tín hiệu tự tính của `subject` được lấy đầu vào từ đó: chính nó và những gì nối trực tiếp với nó. Khớp RelatedSubjects của API,
 * nơi luật này được ép khi lưu. Node: các đường nối vào hoặc ra nó. Đường nối: hai node ở hai đầu và mọi đường nối khác chạm một trong hai đầu
 * (để trừ đi phần đã đi theo đường khác).
 */
export function relatedSubjects(subjects: SubjectView[], subject: string): Set<string> {
  const out = new Set([subject])
  const self = subjects.find((s) => s.subject === subject)
  if (!self) return out
  const touches = (e: SubjectView, node: string) => e.kind === 'edge' && (e.src === node || e.dst === node)
  if (self.kind === 'edge') {
    if (self.src) out.add(self.src)
    if (self.dst) out.add(self.dst)
    for (const s of subjects) if ((self.src && touches(s, self.src)) || (self.dst && touches(s, self.dst))) out.add(s.subject)
    return out
  }
  for (const s of subjects) if (touches(s, subject)) out.add(s.subject)
  return out
}
