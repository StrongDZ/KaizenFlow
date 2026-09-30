import * as Tooltip from '@radix-ui/react-tooltip'
import type { Json } from '../../api/types'
import { fmtDelta, fmtTime } from '../../lib/format'
import { kpiBand } from '../../lib/insights'
import type { AtCursor } from '../../lib/atCursor'

const num = (v?: number) => (v === undefined ? '—' : Math.round(v).toLocaleString('vi-VN'))

function Kpi({ label, help, kpis, k, bad }: { label: string; help: string; kpis: Json | null; k: string; bad?: boolean }) {
  const band = kpiBand(kpis, k)
  const body = (
    <span className="flex cursor-help items-center gap-1.5 whitespace-nowrap">
      <span className="underline decoration-faint decoration-dotted underline-offset-[3px]">{label}</span>
      <b className={`text-[13px] font-semibold tabular-nums ${bad ? 'text-bad-text' : 'text-text'}`}>{num(band?.p50)}</b>
    </span>
  )
  if (!band) return body
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{body}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className="z-50 max-w-[260px] rounded-md border border-line-2 bg-raised px-2.5 py-2 text-[11px] leading-snug text-text-2 shadow-lg">
          <div className="font-semibold text-text">{label}</div>
          <div className="mt-0.5">{help}</div>
          <div className="mt-1.5 flex gap-3">
            <span>Thấp <b className="tabular-nums text-text">{num(band.p10)}</b></span>
            <span>Giữa <b className="tabular-nums text-text">{num(band.p50)}</b></span>
            <span>Cao <b className="tabular-nums text-text">{num(band.p90)}</b></span>
          </div>
          <div className="mt-1 text-faint">Qua các lần lặp: 80% lần lặp nằm giữa Thấp và Cao; Giữa là giá trị điển hình.</div>
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
        <Kpi label="Sản lượng" help="Số thành phẩm đã giao đi trong cả lần chạy." kpis={kpis} k="throughput" />
        <Kpi label="Phút Đỏ" help="Tổng số phút các kho ở mức Đỏ (sắp hết hàng), cộng mọi kho." kpis={kpis} k="red_minutes" bad />
        <Kpi label="Nợ đơn" help="Số đơn khách đã đặt mà chưa có hàng giao khi hết lần chạy." kpis={kpis} k="backorder_end" />
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
