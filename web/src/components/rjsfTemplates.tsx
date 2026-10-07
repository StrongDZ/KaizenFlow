import { getDefaultRegistry } from '@rjsf/core'
import type { ArrayFieldTemplateProps, IconButtonProps, ObjectFieldTemplateProps, RJSFSchema, TitleFieldProps } from '@rjsf/utils'
import type { ReactNode } from 'react'
import { distFields } from './DistField'
import { materialFields } from './MaterialField'

/** Nút mặc định của rjsf chỉ có biểu tượng glyphicon (không có font), nên hiện ra là ô trống. Thay bằng chữ. */
function AddButton({ onClick, disabled }: IconButtonProps) {
  if (disabled) return null // form chỉ xem: không có gì để thêm
  return <button type="button" className="rjsf-add" onClick={onClick} disabled={disabled}>+ Thêm dòng</button>
}

function RemoveButton({ onClick, disabled }: IconButtonProps) {
  if (disabled) return null
  return <button type="button" className="rjsf-remove" onClick={onClick} disabled={disabled}>Xoá dòng</button>
}

/** Tiêu đề phần tử mảng do rjsf tự đặt là "recipes-1", "inputs-1": đọc lên vô nghĩa, đổi thành số thứ tự. */
function TitleFieldTemplate({ id, title }: TitleFieldProps) {
  const item = /_(\d+)__title$/.exec(id)
  return <legend id={id}>{item ? `Dòng ${Number(item[1]) + 1}` : title}</legend>
}

const DefaultArray = getDefaultRegistry().templates.ArrayFieldTemplate
const DefaultObject = getDefaultRegistry().templates.ObjectFieldTemplate

/** Nhóm cấp 1: thuộc tính nằm thẳng dưới gốc của schema (không phải nhóm lồng bên trong). */
function isTopGroup(id: string, rootSchema: RJSFSchema): boolean {
  const props = rootSchema?.properties
  return !!props && Object.keys(props).some((k) => id === `root_${k}`)
}

/** Nhóm gập được: gập sẵn những nhóm không cần đến (cảm biến, chế độ hỏng, ngưỡng...) cho panel ngắn lại. */
function Group({ title, count, open, children }: { title: string; count?: number; open: boolean; children: ReactNode }) {
  return (
    <details className="kf-group" open={open}>
      <summary>{title}{count !== undefined && <span className="kf-count">{count}</span>}</summary>
      {children}
    </details>
  )
}

/**
 * Mở sẵn khi nhóm là bắt buộc của loại node (Công thức, Mỗi lần hàng đến gồm...: bỏ trống thì sơ đồ không hợp lệ) hoặc node
 * đã có dữ liệu riêng ở nhóm đó. Dữ liệu riêng lấy từ formContext.params, không lấy từ formData của rjsf (đã điền sẵn mặc định).
 */
function startsOpen(id: string, registry: ArrayFieldTemplateProps['registry']): boolean {
  const key = id.replace(/^root_/, '')
  if (registry.rootSchema.required?.includes(key)) return true
  const own = ((registry.formContext ?? {}) as { params?: Record<string, unknown> }).params?.[key]
  if (Array.isArray(own)) return own.length > 0
  return typeof own === 'object' && own !== null && Object.keys(own).length > 0
}

function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  if (!isTopGroup(props.idSchema.$id, props.registry.rootSchema)) return <DefaultArray {...props} />
  return <Group title={props.title} count={props.items.length} open={startsOpen(props.idSchema.$id, props.registry)}><DefaultArray {...props} title="" /></Group>
}

function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  if (!isTopGroup(props.idSchema.$id, props.registry.rootSchema)) return <DefaultObject {...props} />
  return <Group title={props.title} open={startsOpen(props.idSchema.$id, props.registry)}><DefaultObject {...props} title="" /></Group>
}

export const rjsfTemplates = { ButtonTemplates: { AddButton, RemoveButton }, TitleFieldTemplate, ArrayFieldTemplate, ObjectFieldTemplate }
export const rjsfFields = { ...distFields, ...materialFields }
