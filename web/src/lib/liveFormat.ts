export const SPEEDS = [1, 10, 60, 300, 600] as const

export function speedLabel(x: number): string {
  const n = Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ',')
  const hint = x === 1 ? ' (thời gian thật)' : x === 60 ? ' (1 phút = 1 giây)' : x === 600 ? ' (1 tuần ≈ 17 phút)' : ''
  return `×${n}${hint}`
}

/** Giờ nhà máy (giờ ảo của feed), theo múi giờ của trình duyệt. */
export function fmtFactoryTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
