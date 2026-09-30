import type { IconButtonProps, TitleFieldProps } from '@rjsf/utils'
import { distFields } from './DistField'

/** Nút mặc định của rjsf chỉ có biểu tượng glyphicon (không có font), nên hiện ra là ô trống. Thay bằng chữ. */
function AddButton({ onClick, disabled }: IconButtonProps) {
  return <button type="button" className="rjsf-add" onClick={onClick} disabled={disabled}>+ Thêm dòng</button>
}

function RemoveButton({ onClick, disabled }: IconButtonProps) {
  return <button type="button" className="rjsf-remove" onClick={onClick} disabled={disabled}>Xoá dòng</button>
}

/** Tiêu đề phần tử mảng do rjsf tự đặt là "recipes-1", "inputs-1": đọc lên vô nghĩa, đổi thành số thứ tự. */
function TitleFieldTemplate({ id, title }: TitleFieldProps) {
  const item = /_(\d+)__title$/.exec(id)
  return <legend id={id}>{item ? `Dòng ${Number(item[1]) + 1}` : title}</legend>
}

export const rjsfTemplates = { ButtonTemplates: { AddButton, RemoveButton }, TitleFieldTemplate }
export const rjsfFields = distFields
