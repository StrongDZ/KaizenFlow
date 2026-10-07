import { getDefaultRegistry } from '@rjsf/core'
import type { FieldProps } from '@rjsf/utils'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { MaterialCreateDialog } from './library/MaterialCreateDialog'
import { SearchSelect } from './SearchSelect'
import { btnLinkAccent } from './ui'

/** Ô chọn vật tư trong form tham số: chọn từ Thư viện, tạo nhanh tại chỗ, cảnh báo khi mã không có trong Thư viện. */
function MaterialField({ formData, onChange, disabled, readonly }: FieldProps) {
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const [creating, setCreating] = useState<string | null>(null)
  const options = useMemo(
    () => (mats.data ?? []).map((m) => ({ value: m.code, label: m.code, hint: m.name && m.name !== m.code ? `${m.name} · ${m.unit}` : m.unit })),
    [mats.data],
  )
  const value = typeof formData === 'string' ? formData : ''
  const off = disabled || readonly
  const unknown = value !== '' && mats.data !== undefined && !mats.data.some((m) => m.code === value)
  return (
    <>
      <SearchSelect
        value={value} options={options} disabled={off} label="Vật tư" placeholder="Chọn vật tư"
        invalid={unknown} invalidHint={`Mã "${value}" chưa có trong Thư viện vật tư.`}
        onChange={(v) => onChange(v as never)}
        createLabel={(t) => `Tạo vật tư "${t}"`} onCreate={(t) => setCreating(t)}
      />
      {unknown && !off && <button type="button" className={btnLinkAccent} onClick={() => setCreating(value)}>Tạo vật tư {value} trong Thư viện</button>}
      {creating !== null && (
        <MaterialCreateDialog initialCode={creating} onClose={() => setCreating(null)} onCreated={(code) => { onChange(code as never); setCreating(null) }} />
      )}
    </>
  )
}

const DefaultString = getDefaultRegistry().fields.StringField

/** Thay StringField của rjsf: mọi thuộc tính tên `material` dùng ô chọn vật tư, các chuỗi khác giữ nguyên. */
function StringField(props: FieldProps) {
  return props.name === 'material' && props.schema.type === 'string' ? <MaterialField {...props} /> : <DefaultString {...props} />
}

export const materialFields = { StringField }
