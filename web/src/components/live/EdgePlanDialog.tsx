import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { EdgePlan, SubjectView } from '../../api/types'
import { planBindings } from '../../lib/edgePlan'
import { FormDialog } from '../FormDialog'
import { Tag } from '../ui'

/**
 * Tự suy lượng hàng trên các đường nối chưa có dữ liệu: hệ thống lập công thức từ bộ đếm của máy, tồn kho và các đường nối khác.
 * Các công thức tham chiếu lẫn nhau (đường này lấy phần còn lại sau khi trừ đường kia) nên áp dụng cả bộ, không bỏ tick từng dòng.
 */
export function EdgePlanDialog({ open, model, plan, subjects, onClose }: { open: boolean; model: string; plan: EdgePlan; subjects: SubjectView[]; onClose: () => void }) {
  const qc = useQueryClient()
  const nameOf = Object.fromEntries(subjects.map((s) => [s.subject, s.name]))
  const apply = useMutation({
    mutationFn: () => api.saveBindings(model, planBindings(plan.items)),
    onSuccess: () => {
      for (const k of ['bindings', 'live', 'live-check', 'edge-plan']) void qc.invalidateQueries({ queryKey: [k, model] })
      onClose()
    },
  })
  const estimates = plan.items.filter((i) => i.estimate).length
  return (
    <FormDialog
      open={open}
      title="Tự suy lượng hàng trên các đường nối"
      description="Những đường nối này chưa có dữ liệu riêng. Hệ thống tính lượng hàng đã chuyển từ bộ đếm của máy, tồn kho và các đường nối khác, kể cả đường rẽ nhánh. Dòng ghi “ước lượng” là số suy ra (chia đều hoặc cân bằng kho), đủ để thấy dòng chảy tương đối nhưng không phải số đo."
      submitLabel={`Áp dụng ${plan.items.length} công thức`}
      pending={apply.isPending}
      error={apply.error}
      canSubmit={plan.items.length > 0}
      onSubmit={() => apply.mutate()}
      onClose={onClose}
    >
      {plan.items.length === 0 ? (
        <p className="text-text-2">Không còn đường nối nào suy được. Ghép bộ đếm cho máy hoặc tồn kho cho kho, hoặc ghép thẳng đường nối.</p>
      ) : (
        <>
          <p className="text-text-2">{plan.items.length} đường nối, trong đó {estimates} là ước lượng. Áp dụng cả bộ vì các công thức tham chiếu lẫn nhau.</p>
          <ul className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
            {plan.items.map((i) => (
              <li key={i.subject} className="rounded-lg border border-line px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <b className="min-w-0 flex-1 truncate text-text">{nameOf[i.subject] ?? i.subject}</b>
                  <Tag>{i.estimate ? 'ước lượng' : 'tính từ bộ đếm'}</Tag>
                </div>
                <div className="text-[11px] text-muted">{i.note}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.skipped.length > 0 && (
        <details className="text-text-2">
          <summary className="cursor-pointer">{plan.skipped.length} đường nối chưa suy được</summary>
          <ul className="mt-1 list-disc pl-5 text-[11px] text-muted">
            {plan.skipped.map((s) => <li key={s.subject}><b>{nameOf[s.subject] ?? s.subject}</b>: {s.reason}</li>)}
          </ul>
        </details>
      )}
    </FormDialog>
  )
}
