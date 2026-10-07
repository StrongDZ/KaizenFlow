import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { slugCode } from '../../lib/naming'
import { isValidMaterialCode } from '../../lib/rules'
import { Field, FormDialog } from '../FormDialog'
import { UnitSelect } from '../UnitSelect'
import { input } from '../ui'

/**
 * Hộp tạo vật tư dùng chung: ở trang Thư viện và tạo nhanh ngay trong ô chọn vật tư của form node.
 * Mount khi cần mở (state khởi tạo từ initialCode), nên không phải đặt lại khi đóng.
 */
export function MaterialCreateDialog({ initialCode = '', onClose, onCreated }: { initialCode?: string; onClose: () => void; onCreated: (code: string) => void }) {
  const qc = useQueryClient()
  const mats = useQuery({ queryKey: ['materials'], queryFn: api.materials })
  const [name, setName] = useState('')
  // Mã tự sinh từ tên cho đến khi người dùng tự sửa mã (hoặc mã đã được truyền sẵn từ ô chọn vật tư).
  const [typed, setTyped] = useState(initialCode.trim())
  const [codeTouched, setCodeTouched] = useState(initialCode.trim() !== '')
  const [unit, setUnit] = useState('pcs')
  const code = codeTouched ? typed : slugCode(name)
  const exists = (mats.data ?? []).some((m) => m.code === code)
  const invalid = code !== '' && !isValidMaterialCode(code)
  const create = useMutation({
    mutationFn: () => api.createMaterial({ code, name: name.trim(), unit: unit.trim() || 'pcs' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['materials'] }); onCreated(code) },
  })
  return (
    <FormDialog
      open title="Tạo vật tư"
      description="Vật tư là loại hàng chạy qua sơ đồ: nguyên liệu, bán thành phẩm, thành phẩm."
      submitLabel="Tạo vật tư" pending={create.isPending} error={create.error}
      canSubmit={isValidMaterialCode(code) && !exists} onSubmit={() => create.mutate()} onClose={onClose}
    >
      <Field label="Tên hiển thị" hint="Tên người dùng đọc được, vd. Thép tấm 1,2 mm. Mã bên dưới tự sinh từ tên.">
        <input autoFocus className={`${input} w-full`} value={name} placeholder="Thép tấm 1,2 mm" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Mã vật tư" hint={codeTouched ? 'Không đổi được sau khi tạo. Chữ, số, gạch nối, gạch dưới. Ví dụ RAW-01, SUB_OK.' : 'Tự sinh từ tên; sửa nếu muốn mã khác. Không đổi được sau khi tạo.'}
        problem={invalid ? 'Mã chỉ gồm chữ, số, gạch dưới, gạch nối và phải bắt đầu bằng chữ hoặc số.' : exists ? 'Mã này đã có trong Thư viện.' : null}
      >
        <input className={`${input} w-full font-mono`} value={code} placeholder="THEP-TAM-1-2-MM" aria-invalid={invalid || exists}
          onChange={(e) => { setTyped(e.target.value); setCodeTouched(e.target.value !== '') }} />
      </Field>
      <div className="space-y-1">
        <span className="block text-text-2">Đơn vị</span>
        <UnitSelect value={unit} used={(mats.data ?? []).map((m) => m.unit)} onChange={setUnit} />
        <span className="block text-faint">Chọn từ danh sách, hoặc gõ đơn vị khác rồi chọn dòng "Dùng …".</span>
      </div>
    </FormDialog>
  )
}
