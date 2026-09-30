import { Plus, Sigma, Sparkles, XCircle } from 'lucide-react'
import type { CoverageStatus } from '../../api/types'

/**
 * Ô một tín hiệu của node hoặc edge, bốn trạng thái có hình và màu riêng (không chỉ dựa vào màu):
 * có nguồn (chấm xanh, vàng khi mất tín hiệu), tự tính (ký hiệu Σ, viền xanh dương), chưa có (nét đứt, dấu +), hỏng (viền đỏ, dấu ✕).
 */
export function SignalChip({ label, status, value, fresh, title, suggested, onClick }: {
  label: string; status: CoverageStatus | undefined; value?: string; fresh: boolean; title: string; suggested?: boolean; onClick: () => void
}) {
  const style =
    status === 'broken' ? 'border-bad/60 text-bad-text hover:bg-bad-bg'
    : status === 'derived' ? 'border-accent/50 text-text hover:bg-panel-2'
    : status === 'source' ? 'border-line-2 text-text hover:bg-panel-2'
    : 'border-dashed border-line-2 text-faint hover:text-text'
  return (
    <button type="button" title={title} onClick={onClick} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${style}`}>
      {status === 'broken' ? <XCircle size={11} aria-hidden />
        : status === 'derived' ? <Sigma size={11} className="text-accent" aria-hidden />
        : status === 'source' ? <i className={`h-1.5 w-1.5 rounded-full ${fresh ? 'bg-ok' : 'bg-warn'}`} />
        : <Plus size={10} aria-hidden />}
      {label}
      {value !== undefined && <b className="tabular-nums">{value}</b>}
      {status === 'missing' && suggested && <Sparkles size={10} className="text-accent" aria-label="Có gợi ý tự tính" />}
    </button>
  )
}
