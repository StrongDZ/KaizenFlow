import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { parseSample, validSourceName } from '../../lib/sourceView'
import { Field, FormDialog } from '../FormDialog'
import { input } from '../ui'

/** Khai báo một nguồn dữ liệu bằng tay: tên, mô tả, và bản tin mẫu để hộp Ghép nối có trường để chọn. */
export function SourceDialog({ existing, onClose, onCreated }: { existing: string[]; onClose: () => void; onCreated: (source: string) => void }) {
  const qc = useQueryClient()
  const [source, setSource] = useState('')
  const [desc, setDesc] = useState('')
  const [sample, setSample] = useState('{\n  "st": "RUN",\n  "cnt": { "ok": 0 }\n}')
  const nameProblem = source === '' ? null : validSourceName(source) ?? (existing.includes(source.trim()) ? 'Nguồn này đã có. Chọn nó trong danh sách để sửa bản tin mẫu.' : null)
  const parsed = parseSample(sample)
  const create = useMutation({
    mutationFn: () => api.addSource({ source: source.trim(), desc: desc.trim(), sample: parsed.ok ? parsed.value : undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['all-sources'] })
      void qc.invalidateQueries({ queryKey: ['sources'] }) // danh sách đã lọc theo từng mô hình
      onCreated(source.trim())
    },
  })
  return (
    <FormDialog
      open title="Thêm nguồn dữ liệu"
      description="Nguồn là một thiết bị hoặc topic gửi bản tin thô. Khai báo trước để ghép được cả khi thiết bị chưa phát dữ liệu."
      submitLabel="Thêm nguồn" pending={create.isPending} error={create.error}
      canSubmit={validSourceName(source) === null && nameProblem === null && parsed.ok} onSubmit={() => create.mutate()} onClose={onClose}
    >
      <Field label="Tên nguồn" hint="Đường dẫn kiểu topic, không có khoảng trắng. Ví dụ plc/prs-02/status." problem={nameProblem}>
        <input autoFocus className={`${input} w-full font-mono`} value={source} placeholder="plc/prs-02/status" onChange={(e) => setSource(e.target.value)} />
      </Field>
      <Field label="Mô tả" hint="Thiết bị này là gì. Bỏ trống cũng được.">
        <input className={`${input} w-full`} value={desc} placeholder="Máy dập 2, trạng thái và bộ đếm" onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Field label="Bản tin mẫu (JSON)" hint="Dán một bản tin thật của thiết bị. Hệ thống đọc các trường trong đó để bạn chọn khi ghép." problem={parsed.ok ? null : parsed.error}>
        <textarea className={`${input} h-36 w-full font-mono`} spellCheck={false} value={sample} onChange={(e) => setSample(e.target.value)} />
      </Field>
    </FormDialog>
  )
}
