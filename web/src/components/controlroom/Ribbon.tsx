import * as Tooltip from '@radix-ui/react-tooltip'
import type { Json } from '../../api/types'
import { fmtDelta, fmtTime } from '../../lib/format'
import { kpiBand } from '../../lib/insights'
import type { AtCursor } from '../../lib/atCursor'

const num = (v?: number) => (v === undefined ? '—' : Math.round(v).toLocaleString('vi-VN'))

function Kpi({ label, kpis, k, bad }: { label: string; kpis: Json | null; k: string; bad?: boolean }) {
  const band = kpiBand(kpis, k)
  const body = (
    <span className="flex cursor-default items-center gap-1.5 whitespace-nowrap">
      {label}
      <b className={`text-[13px] font-semibold tabular-nums ${bad ? 'text-bad-text' : 'text-text'}`}>{num(band?.p50)}</b>
    </span>
  )
  if (!band) return body
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{body}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className="z-50 flex gap-3 rounded-md border border-line-2 bg-raised px-2 py-1 text-[11px] text-text-2 shadow-lg">
          <span>p10 <b className="tabular-nums text-text">{num(band.p10)}</b></span>
          <span>p50 <b className="tabular-nums text-text">{num(band.p50)}</b></span>
          <span>p90 <b className="tabular-nums text-text">{num(band.p90)}</b></span>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function Ribbon({ kpis, at, time, deltaRed }: { kpis: Json | null; at: AtCursor; time: number | undefined; deltaRed?: number }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="absolute inset-x-0 top-0 z-10 flex h-[30px] items-center gap-4 overflow-hidden border-b border-line bg-panel-2 px-3.5 text-[11.5px] text-muted">
        <span className="text-faint">Cả lần chạy</span>
        <Kpi label="Sản lượng" kpis={kpis} k="throughput" />
        <Kpi label="Phút Đỏ" kpis={kpis} k="red_minutes" bad />
        <Kpi label="Nợ đơn" kpis={kpis} k="backorder_end" />
        {deltaRed !== undefined && (
          <span className={`whitespace-nowrap ${deltaRed < 0 ? 'text-ok' : deltaRed > 0 ? 'text-bad-text' : ''}`}>
            so với gốc {fmtDelta(deltaRed)} phút Đỏ
          </span>
        )}
        <span className="h-3.5 w-px bg-line-2" />
        <span className="text-faint">{time === undefined ? 'Theo thước' : `Lúc ${fmtTime(time)}`}</span>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <i className="h-2 w-2 rounded-full bg-bad" /><b className="tabular-nums text-text">{time === undefined ? '—' : at.red}</b> kho Đỏ
        </span>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <i className="h-2 w-2 rounded-full bg-warn" /><b className="tabular-nums text-text">{time === undefined ? '—' : at.yellow}</b> kho Vàng
        </span>
        {at.pools.map((p) => (
          <span key={p.key} className="whitespace-nowrap">
            {p.name} <b className="tabular-nums text-text">{p.busy}/{p.count}</b> bận
          </span>
        ))}
        <span className="ml-auto whitespace-nowrap text-faint">
          <kbd className="rounded border border-line-2 px-1.5 text-[10px] text-muted">F</kbd> ẩn giao diện
        </span>
      </div>
    </Tooltip.Provider>
  )
}
