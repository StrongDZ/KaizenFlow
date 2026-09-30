import type { Option } from './searchSelect'

/** Đơn vị hay gặp trong nhà máy, kèm tên đọc được. Người dùng vẫn gõ được đơn vị khác. */
export const COMMON_UNITS: Option[] = [
  { value: 'pcs', label: 'pcs', hint: 'cái' },
  { value: 'kg', label: 'kg', hint: 'kilôgam' },
  { value: 'g', label: 'g', hint: 'gam' },
  { value: 'm', label: 'm', hint: 'mét' },
  { value: 'l', label: 'l', hint: 'lít' },
  { value: 'set', label: 'set', hint: 'bộ' },
  { value: 'box', label: 'box', hint: 'thùng' },
]

/** Danh sách chọn đơn vị: đơn vị hay gặp trước, rồi những đơn vị khác đang được dùng trong Thư viện. */
export function unitOptions(used: string[]): Option[] {
  const known = new Set(COMMON_UNITS.map((u) => u.value))
  const extra = [...new Set(used.map((u) => u.trim()).filter((u) => u !== '' && !known.has(u)))].sort()
  return [...COMMON_UNITS, ...extra.map((u) => ({ value: u, label: u, hint: 'đang dùng' }))]
}
