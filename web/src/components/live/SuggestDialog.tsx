import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { SubjectView } from '../../api/types'
import type { Suggestion } from '../../lib/suggestMapping'
import { FormDialog } from '../FormDialog'
import { Tag } from '../ui'

const key = (s: Suggestion) => `${s.subject}|${s.signal}`

/** Xem lại các ghép nối được gợi ý tự động trước khi áp dụng: bỏ tick dòng nào không đúng. */
export function SuggestDialog({ open, model, suggestions, unmatched, subjects, onClose }: {
  open: boolean
  model: string
  suggestions: Suggestion[]
  unmatched: string[]
  subjects: SubjectView[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [off, setOff] = useState<Set<string>>(new Set())
  const nameOf = useMemo(() => Object.fromEntries(subjects.map((s) => [s.subject, s.name])), [subjects])
  const chosen = suggestions.filter((s) => !off.has(key(s)))
  const apply = useMutation({
    mutationFn: () => api.saveBindings(model, chosen.map((s) => ({ subject: s.subject, signal: s.signal, source: s.source, json_path: s.json_path, transform: s.transform, enabled: true }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bindings', model] })
      void qc.invalidateQueries({ queryKey: ['live', model] })
      onClose()
    },
  })
  const toggle = (k: string) => setOff((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n })
  return (
    <FormDialog
      open={open}
      title="Gợi ý ghép tự động"
      description="Hệ thống so tên mô tả của từng nguồn với tên node và edge, rồi so tên trường với tín hiệu chuẩn. Kiểm tra lại rồi áp dụng; dòng nào sai thì bỏ tick."
      submitLabel={`Áp dụng ${chosen.length} ghép nối`}
      pending={apply.isPending}
      error={apply.error}
      canSubmit={chosen.length > 0}
      onSubmit={() => apply.mutate()}
      onClose={onClose}
    >
      {suggestions.length === 0 ? (
        <p className="text-text-2">Không có gợi ý mới: mọi nguồn khớp được đều đã ghép, hoặc chưa có nguồn nào đang phát.</p>
      ) : (
        <ul className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
          {suggestions.map((s) => (
            <li key={key(s)}>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-2 py-1.5 hover:bg-panel">
                <input type="checkbox" className="mt-0.5" checked={!off.has(key(s))} onChange={() => toggle(key(s))} />
                <span className="min-w-0 flex-1">
                  <span className="block text-text"><b>{nameOf[s.subject] ?? s.subject}</b> · {s.signal}</span>
                  <span className="block truncate font-mono text-[11px] text-muted">{s.source}{s.json_path ? ` → ${s.json_path}` : ''}</span>
                </span>
                <Tag>{Math.round(s.confidence * 100)}%</Tag>
              </label>
            </li>
          ))}
        </ul>
      )}
      {unmatched.length > 0 && (
        <details className="text-text-2">
          <summary className="cursor-pointer">{unmatched.length} nguồn chưa khớp node nào (ghép tay được)</summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-[11px] text-muted">{unmatched.map((u) => <li key={u}>{u}</li>)}</ul>
        </details>
      )}
    </FormDialog>
  )
}
