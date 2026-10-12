import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import type { Asset } from '../../api/types'
import { Field, FormDialog } from '../FormDialog'
import { input } from '../ui'

const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * Tạo hoặc sửa một thiết bị. Thiết bị là thứ có thật trong nhà máy, định danh duy nhất toàn app:
 * mã ở đây cũng là mã node trên mọi sơ đồ dùng nó, và là machine_id khi gắn đồng hồ.
 * Sửa: không cho đổi mã (đổi mã là một thiết bị khác), và không cho đổi loại khi đã nằm trong sơ đồ.
 */
export function AssetDialog({ edit, onClose, onSaved }: { edit?: Asset; onClose: () => void; onSaved: (key: string) => void }) {
  const qc = useQueryClient()
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets })
  const [key, setKey] = useState(edit?.key ?? '')
  const [name, setName] = useState(edit?.name ?? '')
  const [plant, setPlant] = useState(edit?.plant ?? '')
  const [line, setLine] = useState(edit?.line ?? '')
  const [nodeType, setNodeType] = useState(edit?.node_type ?? '')
  const [note, setNote] = useState(edit?.note ?? '')
  const [retired, setRetired] = useState(edit?.retired ?? false)
  const inUse = (edit?.models.length ?? 0) > 0
  const taken = !edit && (assets.data ?? []).some((a) => a.key === key)
  const invalidKey = key !== '' && !KEY_RE.test(key)
  const save = useMutation({
    mutationFn: () => api.putAsset({ key, name: name.trim(), plant: plant.trim(), line: line.trim(), node_type: nodeType, note: note.trim(), retired }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
      onSaved(key)
    },
  })
  return (
    <FormDialog
      open title={edit ? `Sửa thiết bị ${edit.key}` : 'Tạo thiết bị'}
      description={edit
        ? 'Tham số khai ở đây áp cho mọi mô hình có thiết bị này. Sơ đồ chỉ override khi thật cần.'
        : 'Thiết bị có thật trong nhà máy. Mã là duy nhất toàn app: mọi sơ đồ dùng chung mã này, và đây cũng là mã máy khi gắn đồng hồ.'}
      submitLabel={edit ? 'Lưu' : 'Tạo thiết bị'} pending={save.isPending} error={save.error}
      canSubmit={KEY_RE.test(key) && nodeType !== '' && !taken} onSubmit={() => save.mutate()} onClose={onClose}
    >
      <Field
        label="Mã thiết bị"
        hint={edit ? 'Không đổi được: đổi mã là một thiết bị khác.' : 'Chữ, số, dấu "_", "." và "-". Ví dụ STAMP_1, LO_HOI_05.'}
        problem={invalidKey ? 'Mã chỉ gồm chữ, số, "_", "." và "-", dài tối đa 64 ký tự.' : taken ? 'Mã này đã có trong danh mục.' : null}
      >
        <input autoFocus={!edit} className={`${input} w-full font-mono`} value={key} placeholder="STAMP_1" disabled={!!edit}
          aria-invalid={invalidKey || taken} onChange={(e) => setKey(e.target.value.trim())} />
      </Field>
      <Field label="Tên hiển thị" hint="Tên người vận hành đọc, vd. Máy dập 1.">
        <input className={`${input} w-full`} value={name} placeholder="Máy dập 1" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Loại node"
        hint={inUse ? `Đang nằm trong ${edit?.models.length} mô hình nên không đổi được loại.` : 'Loại quyết định tham số và vai trò của thiết bị trong sơ đồ.'}
      >
        <select className={`${input} w-full`} value={nodeType} disabled={inUse} onChange={(e) => setNodeType(e.target.value)}>
          <option value="">— chọn loại —</option>
          {(types.data ?? []).map((t) => <option key={t.code} value={t.code}>{t.name} ({t.code})</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nhà máy" hint="Để nhóm trong danh mục.">
          <input className={`${input} w-full`} value={plant} placeholder="NHA_MAY_1" onChange={(e) => setPlant(e.target.value)} />
        </Field>
        <Field label="Dây chuyền" hint="Cùng cách đặt với bên Đồng hồ.">
          <input className={`${input} w-full`} value={line} placeholder="L01" onChange={(e) => setLine(e.target.value)} />
        </Field>
      </div>
      <Field label="Ghi chú" hint="Tuỳ chọn: vị trí, số hiệu, điều cần biết khi bảo trì.">
        <input className={`${input} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {edit && (
        <label className="flex items-center gap-2 text-text-2">
          <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
          Ngừng dùng (giữ lịch sử số liệu, không đặt lên sơ đồ mới nữa)
        </label>
      )}
    </FormDialog>
  )
}
