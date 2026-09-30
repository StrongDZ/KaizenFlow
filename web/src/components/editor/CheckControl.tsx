import * as Popover from '@radix-ui/react-popover'
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { CheckInferred, CheckIssue, CheckReport } from '../../api/types'
import { groupIssues, reportLabel } from '../../lib/checkView'
import { btn, btnAccentOutline } from '../ui'

const SOURCE: Record<CheckInferred['source'], string> = {
  node_type_default: 'mặc định của loại node',
  sim_default: 'mặc định của mô phỏng',
  agv_map: 'gợi ý từ bản đồ AGV',
}

function Row({ issue, onSelect, icon }: { issue: CheckIssue; onSelect: (key: string) => void; icon: React.ReactNode }) {
  const selectable = issue.key !== 'model'
  const body = (
    <>
      <span className="mt-0.5 flex-none">{icon}</span>
      <span className="min-w-0 flex-1">{issue.message}</span>
    </>
  )
  return (
    <li>
      {selectable ? (
        <button type="button" onClick={() => onSelect(issue.key)} title="Chọn trên sơ đồ" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-text-2 hover:bg-panel">{body}</button>
      ) : (
        <div className="flex items-start gap-2 px-2 py-1.5 text-text-2">{body}</div>
      )}
    </li>
  )
}

/**
 * Nút "Kiểm tra" cạnh Lưu và panel kết quả: Lỗi (chặn Publish), Cảnh báo (nên sửa), và những thông số sẽ dùng giá trị thay thế.
 * Mở panel là kiểm sâu ngay; bấm một dòng thì chọn node hoặc đường nối đó trên sơ đồ.
 */
export function CheckControl({ report, checking, onRun, onSelect }: {
  report: CheckReport | undefined; checking: boolean; onRun: () => void; onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const g = groupIssues(report)
  const icon = !report ? <Loader2 size={13} className="animate-spin" aria-hidden />
    : g.errors.length > 0 ? <XCircle size={13} className="text-bad-text" aria-hidden />
    : g.warnings.length > 0 ? <AlertTriangle size={13} className="text-warn" aria-hidden />
    : <CheckCircle2 size={13} className="text-ok" aria-hidden />
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) onRun() }}>
      <Popover.Trigger asChild>
        <button className={btn} title="Kiểm tra sơ đồ: lỗi, cảnh báo và thông số sẽ dùng giá trị thay thế">
          {icon}{reportLabel(report, checking)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12}
          className="z-[70] max-h-[72vh] w-[420px] overflow-y-auto rounded-xl border border-line-2 bg-raised p-3 text-xs shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-text">Kiểm tra sơ đồ</div>
              <div className="text-muted">{checking ? 'Đang kiểm tra…' : report?.ok ? 'Publish được (không có lỗi).' : 'Còn lỗi, chưa Publish được.'}</div>
            </div>
            <button className={btnAccentOutline} disabled={checking} onClick={onRun}>Kiểm tra lại</button>
          </div>
          {report && g.errors.length === 0 && g.warnings.length === 0 && (
            <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-text-2">Sơ đồ hợp lệ, không có cảnh báo.</p>
          )}
          {g.errors.length > 0 && (
            <section className="mb-2">
              <h3 className="px-2 pb-1 font-semibold text-bad-text">Lỗi ({g.errors.length})</h3>
              <ul>{g.errors.map((i) => <Row key={`${i.key}|${i.code}|${i.message}`} issue={i} onSelect={(k) => { onSelect(k); setOpen(false) }} icon={<XCircle size={13} className="text-bad-text" aria-hidden />} />)}</ul>
            </section>
          )}
          {g.warnings.length > 0 && (
            <section className="mb-2">
              <h3 className="px-2 pb-1 font-semibold text-lock-text">Cảnh báo ({g.warnings.length})</h3>
              <ul>{g.warnings.map((i) => <Row key={`${i.key}|${i.code}|${i.message}`} issue={i} onSelect={(k) => { onSelect(k); setOpen(false) }} icon={<AlertTriangle size={13} className="text-warn" aria-hidden />} />)}</ul>
            </section>
          )}
          {g.inferred.length > 0 && (
            <details className="rounded-lg border border-line">
              <summary className="cursor-pointer px-3 py-2 font-semibold text-text-2">Sẽ dùng giá trị thay thế ({g.inferred.length})</summary>
              <ul className="border-t border-line py-1">
                {g.inferred.map((i) => (
                  <li key={`${i.key}|${i.param}`}>
                    <button type="button" onClick={() => { onSelect(i.key); setOpen(false) }} title="Chọn trên sơ đồ"
                      className="flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-left text-text-2 hover:bg-panel">
                      <Info size={13} className="mt-0.5 flex-none text-muted" aria-hidden />
                      <span className="min-w-0 flex-1">{i.message}<span className="block text-[10.5px] text-faint">{SOURCE[i.source]}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
