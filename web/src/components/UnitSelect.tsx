import { useMemo } from 'react'
import type { Option } from '../lib/searchSelect'
import { unitOptions } from '../lib/units'
import { SearchSelect } from './SearchSelect'

/** Chọn đơn vị từ danh sách (đơn vị hay gặp và đơn vị đang dùng); gõ đơn vị mới thì có dòng "Dùng …". */
export function UnitSelect({ value, used, onChange, disabled, label = 'Đơn vị', presets }: {
  value: string; used: string[]; onChange: (v: string) => void; disabled?: boolean; label?: string; presets?: Option[]
}) {
  const options = useMemo(() => unitOptions(used, presets), [used, presets])
  return (
    <SearchSelect
      value={value} options={options} onChange={onChange} disabled={disabled} label={label} placeholder="Chọn đơn vị"
      createLabel={(t) => `Dùng đơn vị "${t}"`} onCreate={onChange}
    />
  )
}
