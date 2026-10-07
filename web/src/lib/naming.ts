/** Sinh mã từ tên và đặt tên tự tăng cho các form tạo mới, để người dùng có sẵn giá trị hợp lệ thay vì nghĩ ra từ đầu. */

/**
 * Mã từ tên: bỏ dấu tiếng Việt, viết hoa, mọi chuỗi ký tự không phải chữ số hoặc chữ cái thành một dấu nối `sep`.
 * `startWithLetter`: mã loại node phải bắt đầu bằng chữ cái, nên nếu tên bắt đầu bằng số thì thêm tiền tố X.
 */
export function slugCode(name: string, sep = '-', opts: { startWithLetter?: boolean } = {}): string {
  const base = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toUpperCase().replace(/[^A-Z0-9]+/g, sep)
    .replace(new RegExp(`^${sep === '-' ? '\\-' : sep}+|${sep === '-' ? '\\-' : sep}+$`, 'g'), '')
  if (base === '') return ''
  return opts.startWithLetter && /^[0-9]/.test(base) ? `X${sep}${base}` : base
}

/** "Kịch bản 1", "Kịch bản 2"…: số thứ tự nhỏ nhất chưa có tên nào dùng (không phân biệt hoa thường). */
export function nextName(base: string, existing: string[]): string {
  const used = new Set(existing.map((n) => n.trim().toLowerCase()))
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`
    if (!used.has(name.toLowerCase())) return name
  }
}
