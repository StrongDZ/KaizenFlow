import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { Binding, LiveSnapshot, SignalCoverage } from '../../api/types'
import { filterBindingRows, toggleInput, type BindingRow, type RowStatus, type TableView } from '../../lib/bindingsTable'
import { statusKey } from '../../lib/connectView'
import { STALE_MS } from '../../lib/liveFrame'
import { ageText } from '../../lib/sourceView'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState, ErrorBox, FilterChip, SearchBox, btn, btnDangerOutline } from '../ui'

const STATUS_TEXT: Record<RowStatus, string> = { source: 'Nhận dữ liệu', derived: 'Tự tính', missing: 'Chưa có', broken: 'Hỏng', off: 'Đang tắt' }

/**
 * Bảng phẳng mọi ghép nối của mô hình: xem cái nào đang lấy từ đâu, giá trị cuối, lần cập nhật, lỗi; bật hoặc tắt từng cái;
 * chọn nhiều để bật, tắt hay xoá hàng loạt. Sửa một ghép nối mở lại hộp Ghép nối.
 */
export function BindingsTable({ model, rows, coverage, snapshot, onEdit }: {
  model: string; rows: BindingRow[]; coverage: Map<string, SignalCoverage>; snapshot?: LiveSnapshot; onEdit: (b: Binding) => void
}) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [view, setView] = useState<TableView>('all')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const shown = useMemo(() => filterBindingRows(rows, { q, view }), [rows, q, view])
  const count = (v: TableView) => filterBindingRows(rows, { q: '', view: v }).length
  const refresh = () => {
    setPicked(new Set())
    for (const k of ['bindings', 'live', 'live-check']) void qc.invalidateQueries({ queryKey: [k, model] })
  }
  const toggle = useMutation({
    mutationFn: (p: { list: Binding[]; enabled: boolean }) => api.saveBindings(model, p.list.map((b) => toggleInput(b, p.enabled))),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => api.deleteBinding(model, id))),
    onSuccess: () => { setConfirmDelete(false); refresh() },
  })
  const chosen = shown.filter((r) => picked.has(r.binding.id))
  const allOn = shown.length > 0 && chosen.length === shown.length
  const flip = (id: number) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {([['all', 'Tất cả'], ['problem', 'Đang lỗi'], ['off', 'Đang tắt'], ['derived', 'Tự tính']] as [TableView, string][]).map(([v, label]) => (
          <FilterChip key={v} active={view === v} onClick={() => setView(v)}>{label} {count(v)}</FilterChip>
        ))}
        <div className="ml-auto"><SearchBox value={q} onChange={setQ} placeholder="Tìm đối tượng, tín hiệu, nguồn" /></div>
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs">
          <span className="text-text-2">Đã chọn {chosen.length} ghép nối</span>
          <button className={btn} disabled={toggle.isPending} onClick={() => toggle.mutate({ list: chosen.map((r) => r.binding), enabled: true })}>Bật</button>
          <button className={btn} disabled={toggle.isPending} onClick={() => toggle.mutate({ list: chosen.map((r) => r.binding), enabled: false })}>Tắt</button>
          <button className={btnDangerOutline} onClick={() => setConfirmDelete(true)}>Xoá</button>
          <button className="ml-auto text-muted underline decoration-dotted hover:text-text" onClick={() => setPicked(new Set())}>Bỏ chọn</button>
        </div>
      )}
      <ErrorBox error={toggle.error ?? remove.error} />
      {shown.length === 0 ? (
        <EmptyState title={rows.length === 0 ? 'Chưa có ghép nối nào' : 'Không có ghép nối khớp'}>
          {rows.length === 0 ? 'Bấm một ô tín hiệu ở tab Node hoặc Đường nối để ghép, hoặc dùng "Gợi ý ghép tự động".' : 'Đổi bộ lọc hoặc từ khoá.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th scope="col" className="w-8 border-b border-line px-2 py-2">
                  <input type="checkbox" aria-label="Chọn tất cả ghép nối đang hiện" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(shown.map((r) => r.binding.id)))} />
                </th>
                {['Đối tượng', 'Tín hiệu', 'Lấy từ', 'Giá trị', 'Cập nhật', 'Trạng thái', 'Bật', ''].map((h) => <th key={h} scope="col" className="border-b border-line px-2 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const b = r.binding
                const snap = snapshot?.subjects[b.subject]
                const stale = snap !== undefined && snap.age_ms >= STALE_MS
                const reason = coverage.get(statusKey(b.subject, b.signal))?.reason
                const text = r.orphan ? 'Đối tượng không còn trong sơ đồ' : r.status === 'source' && stale ? 'Mất tín hiệu' : STATUS_TEXT[r.status]
                return (
                  <tr key={b.id} className={`border-b border-line/60 last:border-0 ${r.status === 'off' ? 'opacity-60' : ''}`}>
                    <td className="px-2 py-1.5"><input type="checkbox" aria-label={`Chọn ${r.subjectName} ${r.signalLabel}`} checked={picked.has(b.id)} onChange={() => flip(b.id)} /></td>
                    <td className="max-w-[200px] px-2 py-1.5"><div className="truncate font-medium text-text">{r.subjectName}</div><div className="truncate text-[10.5px] text-faint">{b.subject}</div></td>
                    <td className="px-2 py-1.5 text-text-2">{r.signalLabel}</td>
                    <td className="max-w-[260px] px-2 py-1.5">
                      <span className="mr-1.5 inline-block rounded border border-line-2 px-1 text-[10px] text-text-2">{r.how}</span>{r.estimate && <span className="mr-1.5 inline-block rounded border border-warn px-1 text-[10px] text-warn" title="Số suy ra (chia đều, cân bằng kho), không phải số đo">ước lượng</span>}
                      <span className="break-all font-mono text-[10.5px] text-muted" title={r.detail}>{r.detail}</span>
                    </td>
                    <td className="px-2 py-1.5 tabular-nums text-text">{r.value ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted">{snap && r.status !== 'off' ? ageText(snap.age_ms) : '—'}</td>
                    <td className={`whitespace-nowrap px-2 py-1.5 ${r.status === 'broken' || stale ? 'text-bad-text' : 'text-text-2'}`} title={reason}>{text}</td>
                    <td className="px-2 py-1.5">
                      <button
                        role="switch" aria-checked={b.enabled} aria-label={`${b.enabled ? 'Tắt' : 'Bật'} ghép nối ${r.subjectName} ${r.signalLabel}`} disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ list: [b], enabled: !b.enabled })}
                        className={`relative h-4 w-7 rounded-full border ${b.enabled ? 'border-ok-solid bg-ok-solid' : 'border-line-2 bg-panel-2'}`}
                      >
                        <i className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-bg transition-all ${b.enabled ? 'left-[14px]' : 'left-0.5 bg-faint'}`} />
                      </button>
                    </td>
                    <td className="px-2 py-1.5"><button aria-label={`Sửa ghép nối ${r.subjectName} ${r.signalLabel}`} className="text-muted hover:text-text" onClick={() => onEdit(b)}><Pencil size={13} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete} title={`Xoá ${chosen.length} ghép nối?`} pending={remove.isPending} error={remove.error} confirmLabel="Xoá"
        description={<>Các tín hiệu này sẽ ngừng nhận dữ liệu cho đến khi ghép lại. Công thức tự tính dùng chúng làm đầu vào sẽ báo hỏng.</>}
        onConfirm={() => remove.mutate(chosen.map((r) => r.binding.id))} onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
