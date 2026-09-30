/** Phím tắt của Editor. Hàm thuần: nhận thông tin phím, trả tên hành động (hoặc null nếu không phải phím của mình). */
export type Action =
  | 'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'selectAll' | 'save'
  | 'toolSelect' | 'toolHand' | 'add' | 'help' | 'escape' | 'focus'
  | 'fit' | 'zoom100' | 'fitSelection'

type KeyInfo = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }

export function shortcutFor(e: KeyInfo): Action | null {
  if (e.altKey) return null
  const key = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (e.shiftKey) return null
    switch (key) {
      case 'y': return 'redo'
      case 'c': return 'copy'
      case 'v': return 'paste'
      case 'd': return 'duplicate'
      case 'a': return 'selectAll'
      case 's': return 'save'
      default: return null
    }
  }
  if (key === '?') return 'help'
  if (e.shiftKey) {
    // Shift đổi ký tự của phím số (Shift+1 ra "!"), nên nhận theo mã phím vật lý.
    if (e.code === 'Digit1') return 'fit'
    if (e.code === 'Digit0') return 'zoom100'
    if (e.code === 'Digit2') return 'fitSelection'
    return null
  }
  switch (key) {
    case 'v': return 'toolSelect'
    case 'h': return 'toolHand'
    case 'f': return 'focus'
    case 'tab':
    case '/': return 'add'
    case 'escape': return 'escape'
    default: return null
  }
}

export type ShortcutRow = { group: string; keys: string; label: string }

export const SHORTCUTS: ShortcutRow[] = [
  { group: 'Chọn và di chuyển', keys: 'Kéo trên vùng trống', label: 'Chọn nhiều node bằng khung' },
  { group: 'Chọn và di chuyển', keys: 'Shift hoặc Ctrl/⌘ + bấm', label: 'Thêm hoặc bỏ một node khỏi vùng chọn' },
  { group: 'Chọn và di chuyển', keys: 'Ctrl/⌘ + A', label: 'Chọn tất cả' },
  { group: 'Chọn và di chuyển', keys: 'Esc', label: 'Bỏ chọn, đóng ô đang mở' },
  { group: 'Chọn và di chuyển', keys: 'Space + kéo, hoặc chuột giữa', label: 'Kéo canvas' },
  { group: 'Chọn và di chuyển', keys: 'V', label: 'Công cụ Chọn' },
  { group: 'Chọn và di chuyển', keys: 'H', label: 'Công cụ Kéo canvas (bàn tay)' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + C', label: 'Sao chép các node đã chọn' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + V', label: 'Dán' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + D', label: 'Nhân đôi' },
  { group: 'Sửa', keys: 'Delete hoặc Backspace', label: 'Xoá các mục đã chọn' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + Z', label: 'Hoàn tác' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + Shift + Z, hoặc Ctrl/⌘ + Y', label: 'Làm lại' },
  { group: 'Sửa', keys: 'Ctrl/⌘ + S', label: 'Lưu' },
  { group: 'Thêm node', keys: 'Tab hoặc /', label: 'Mở ô tìm loại node để thêm' },
  { group: 'Thêm node', keys: 'Bấm đúp vào chỗ trống', label: 'Thêm node ngay tại đó' },
  { group: 'Thêm node', keys: 'Kéo dây từ một chấm ra chỗ trống', label: 'Thêm node và tự nối' },
  { group: 'Xem', keys: 'Shift + 1', label: 'Vừa khung' },
  { group: 'Xem', keys: 'Shift + 2', label: 'Vừa vùng chọn' },
  { group: 'Xem', keys: 'Shift + 0', label: 'Thu phóng 100%' },
  { group: 'Xem', keys: 'F', label: 'Ẩn hoặc hiện giao diện' },
  { group: 'Xem', keys: '?', label: 'Mở bảng phím tắt này' },
]
