import { CheckCircle2, CircleAlert } from 'lucide-react'
import type { CoverageReport } from '../../api/types'
import { readinessLabel } from '../../lib/connectView'

/**
 * Mỗi chức năng của live có đủ tín hiệu chưa ("Live: đủ", "Dự báo từ live: thiếu 2"). Bấm một chức năng còn thiếu để
 * chỉ hiện những đối tượng còn thiếu tín hiệu cho nó; bấm lần nữa để bỏ lọc.
 */
export function ReadinessBar({ report, active, onPick }: { report: CoverageReport | undefined; active: string | null; onPick: (feature: string | null) => void }) {
  if (!report || report.readiness.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Mức đủ tín hiệu của từng chức năng">
      {report.readiness.map((r) => {
        const on = active === r.feature
        return (
          <button
            key={r.feature} type="button" disabled={r.ok} aria-pressed={on}
            title={r.ok ? 'Đủ tín hiệu cho chức năng này' : 'Bấm để chỉ hiện những tín hiệu còn thiếu cho chức năng này'}
            onClick={() => onPick(on ? null : r.feature)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] disabled:cursor-default ${
              r.ok ? 'border-line-2 text-text-2' : on ? 'border-lock-line bg-lock-bg text-lock-text' : 'border-lock-line text-lock-text hover:bg-lock-bg'
            }`}
          >
            {r.ok ? <CheckCircle2 size={12} className="text-ok" aria-hidden /> : <CircleAlert size={12} aria-hidden />}
            {readinessLabel(r)}
          </button>
        )
      })}
    </div>
  )
}
