import { useMemo } from 'react'
import { leafPaths } from '../../lib/livePath'
import { SearchSelect } from '../SearchSelect'

/** Chọn một trường trong bản tin mẫu của nguồn (kèm giá trị hiện có) thay vì gõ đường dẫn; gõ đường dẫn khác được khi bản tin mẫu thiếu trường đó. */
export function FieldPicker({ sample, value, onChange, disabled, placeholder }: {
  sample: unknown; value: string; onChange: (path: string) => void; disabled?: boolean; placeholder?: string
}) {
  const options = useMemo(() => leafPaths(sample, 120).map((l) => ({ value: l.path, label: l.path || '(cả bản tin)', hint: String(l.value) })), [sample])
  return (
    <SearchSelect
      value={value} options={options} onChange={onChange} disabled={disabled} label="Trường trong bản tin"
      placeholder={placeholder ?? (options.length > 0 ? 'Chọn trường trong bản tin' : 'Nguồn chưa có bản tin mẫu: gõ đường dẫn rồi chọn dòng "Dùng…"')}
      createLabel={(t) => `Dùng đường dẫn "${t}"`} onCreate={onChange}
    />
  )
}
