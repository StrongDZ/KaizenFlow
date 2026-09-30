/** Các biểu tượng có thể chọn cho một loại node (lưu ở ui.icon). Tên trùng tên lucide viết thường; hình vẽ nằm ở components/nodeIcons.tsx. */
export const ICON_CHOICES: { name: string; label: string }[] = [
  { name: 'truck', label: 'Xe tải, nhận hàng' },
  { name: 'warehouse', label: 'Kho' },
  { name: 'store', label: 'Siêu thị' },
  { name: 'inbox', label: 'Khay, buffer' },
  { name: 'boxes', label: 'Hàng hoá' },
  { name: 'container', label: 'Container' },
  { name: 'hammer', label: 'Máy dập' },
  { name: 'puzzle', label: 'Lắp ráp' },
  { name: 'drill', label: 'Khoan, gia công' },
  { name: 'paintbrush', label: 'Sơn' },
  { name: 'flame', label: 'Lò, nhiệt' },
  { name: 'cog', label: 'Máy' },
  { name: 'factory', label: 'Nhà máy' },
  { name: 'cpu', label: 'Điều khiển' },
  { name: 'search', label: 'Kiểm tra' },
  { name: 'scan', label: 'Quét, kiểm tra ảnh' },
  { name: 'microscope', label: 'Kiểm tra chất lượng' },
  { name: 'gauge', label: 'Đo' },
  { name: 'package', label: 'Đóng gói' },
  { name: 'send', label: 'Xuất hàng' },
  { name: 'trash', label: 'Phế phẩm' },
  { name: 'tractor', label: 'Xe kéo' },
  { name: 'forklift', label: 'Xe nâng' },
  { name: 'bot', label: 'AGV, robot' },
  { name: 'user', label: 'Người' },
  { name: 'users', label: 'Nhóm người' },
  { name: 'wrench', label: 'Bảo trì' },
  { name: 'route', label: 'Tuyến vận chuyển' },
  { name: 'layers', label: 'Xếp lớp' },
  { name: 'zap', label: 'Điện' },
  { name: 'thermometer', label: 'Nhiệt độ' },
]

/** Bản sao của ui với icon được đặt (hoặc bỏ nếu không chọn). API thay cả đối tượng ui khi lưu, nên phải giữ các khoá khác như color. */
export function withIcon(ui: Record<string, unknown> | undefined, icon: string | undefined): Record<string, unknown> {
  const rest = { ...(ui ?? {}) }
  delete rest.icon
  return icon ? { ...rest, icon } : rest
}
