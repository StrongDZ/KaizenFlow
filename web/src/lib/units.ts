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

/** Đơn vị hay gặp của cảm biến máy. */
export const SENSOR_UNITS: Option[] = [
  { value: 'mm/s', label: 'mm/s', hint: 'độ rung' },
  { value: '°C', label: '°C', hint: 'nhiệt độ' },
  { value: 'bar', label: 'bar', hint: 'áp suất' },
  { value: 'A', label: 'A', hint: 'dòng điện' },
  { value: 'V', label: 'V', hint: 'điện áp' },
  { value: 'rpm', label: 'rpm', hint: 'vòng mỗi phút' },
  { value: 'Hz', label: 'Hz', hint: 'tần số' },
  { value: '%', label: '%', hint: 'phần trăm' },
  { value: 'kW', label: 'kW', hint: 'công suất' },
]

/** Danh sách chọn đơn vị: đơn vị hay gặp trước (mặc định là đơn vị vật tư), rồi những đơn vị khác đang được dùng. */
export function unitOptions(used: string[], presets: Option[] = COMMON_UNITS): Option[] {
  const known = new Set(presets.map((u) => u.value))
  const extra = [...new Set(used.map((u) => u.trim()).filter((u) => u !== '' && !known.has(u)))].sort()
  return [...presets, ...extra.map((u) => ({ value: u, label: u, hint: 'đang dùng' }))]
}
