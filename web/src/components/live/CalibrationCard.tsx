import { useMutation, useQuery, useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { CalibrationApplied } from '../../api/types'
import { statusLabel } from '../../lib/format'
import { Card, ErrorBox, Tag, btnPrimary } from '../ui'

const sec = (v: number) => `${Math.round(v)} s`
const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}%`

/**
 * Hiệu chỉnh thời gian chuyến: so thời gian xe thực sự đi (đo từ bản đồ, có cả kẹt xe) với `travel` mô hình đang giả định.
 * Áp dụng = tạo hai scenario cùng seed, một giữ travel cũ, một dùng travel đo được, rồi chạy cả hai để so. Không sửa version đã Publish.
 */
export function CalibrationCard({ model }: { model: string }) {
  const cal = useQuery({ queryKey: ['calibration', model], queryFn: () => api.calibration(model), refetchInterval: 5000, retry: false })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [applied, setApplied] = useState<CalibrationApplied | null>(null)
  const apply = useMutation({ mutationFn: (edges: string[]) => api.applyCalibration(model, edges), onSuccess: setApplied })
  const runs = useQueries({
    queries: applied ? [applied.baseline_run_id, applied.run_id].map((id) => ({ queryKey: ['run', id], queryFn: () => api.run(id), refetchInterval: 2500 })) : [],
  })

  const edges = cal.data?.edges ?? []
  // Mặc định chọn các edge lệch đáng kể (trên 10%).
  const chosen = picked ?? new Set(edges.filter((e) => e.significant).map((e) => e.edge))
  const toggle = (edge: string) => { const n = new Set(chosen); if (n.has(edge)) n.delete(edge); else n.add(edge); setPicked(n) }
  const bothDone = runs.length === 2 && runs.every((r) => r.data?.status === 'DONE')

  return (
    <Card title="Hiệu chỉnh thời gian chuyến">
      <div className="space-y-3 text-xs text-text-2">
        <p>
          So thời gian xe thực sự đi giữa hai trạm (đo trên bản đồ, kể cả lúc kẹt) với thời gian <code>travel</code> mà mô hình đang dùng để dự báo.
          Lệch nhiều thì dự báo về xe sẽ sai theo.
        </p>
        {cal.isError && <ErrorBox error={cal.error} />}
        {edges.length === 0 && (cal.data?.waiting.length ?? 0) === 0 && !cal.isError && (
          <p className="text-muted">Chưa đo được chuyến nào. Ghép tín hiệu "Thời gian một chuyến" của các edge chạy bằng xe ở tab Kết nối dữ liệu, rồi bật feed.</p>
        )}
        {edges.length > 0 && (
          <table className="w-full">
            <thead className="text-left text-[11px] text-muted">
              <tr><th className="w-6" /><th className="font-medium">Edge</th><th className="text-right font-medium">Số chuyến</th><th className="text-right font-medium">Mô hình</th><th className="text-right font-medium">Đo được</th><th className="text-right font-medium">Lệch</th></tr>
            </thead>
            <tbody>
              {edges.map((e) => (
                <tr key={e.edge} className="border-t border-line">
                  <td className="py-1.5"><input type="checkbox" aria-label={`Chọn ${e.name}`} checked={chosen.has(e.edge)} onChange={() => toggle(e.edge)} /></td>
                  <td className="py-1.5"><div className="text-text">{e.name}</div><div className="text-[10.5px] text-faint">{e.material} · {e.edge}</div></td>
                  <td className="py-1.5 text-right tabular-nums">{e.n}</td>
                  <td className="py-1.5 text-right tabular-nums">{e.current_mean_s > 0 ? sec(e.current_mean_s) : 'chưa khai'}</td>
                  <td className="py-1.5 text-right tabular-nums text-text">{sec(e.mean_s)} <span className="text-faint">(90%: {sec(e.p90_s)})</span></td>
                  <td className={`py-1.5 text-right tabular-nums ${e.significant ? 'font-semibold text-warn' : 'text-muted'}`}>{e.current_mean_s > 0 ? pct(e.delta_pct) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(cal.data?.waiting.length ?? 0) > 0 && (
          <p className="text-muted">Đang đo thêm (cần {cal.data!.min_trips} chuyến): {cal.data!.waiting.map((w) => `${w.name} ${w.n}/${cal.data!.min_trips}`).join(', ')}.</p>
        )}
        {edges.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button className={btnPrimary} disabled={chosen.size === 0 || apply.isPending} onClick={() => apply.mutate([...chosen])}>
              Áp dụng {chosen.size} edge và chạy so sánh
            </button>
            <span className="text-[11px] text-faint">Tạo scenario nền và scenario hiệu chỉnh (cùng seed), chạy 4 giờ mỗi cái.</span>
          </div>
        )}
        <ErrorBox error={apply.error} />
        {applied && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2 p-2">
            <Tag>Nền: {runs[0]?.data ? statusLabel(runs[0].data.status) : '…'}</Tag>
            <Tag>Hiệu chỉnh: {runs[1]?.data ? statusLabel(runs[1].data.status) : '…'}</Tag>
            {bothDone
              ? <Link className={btnPrimary} to={`/compare?a=${applied.baseline_run_id}&b=${applied.run_id}`}>Mở so sánh hai lần chạy</Link>
              : <span className="text-muted">Đang chạy mô phỏng…</span>}
          </div>
        )}
      </div>
    </Card>
  )
}
