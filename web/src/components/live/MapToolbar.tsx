import { Maximize, Minus, PanelLeft, Plus, Table2 } from 'lucide-react'
import type { ReactNode } from 'react'

export type MapTool = 'select' | 'junction' | 'station' | 'connect'

const base = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-text-2 hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'
const on = 'bg-raised text-text'

function Btn({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick} className={`${base} ${active ? on : ''}`}>
      {children}
    </button>
  )
}

const Sep = () => <span aria-hidden className="mx-0.5 h-4 w-px flex-none bg-line-2" />

const TOOLS: [MapTool, string, string][] = [
  ['select', 'Chọn, kéo', 'Chọn và kéo điểm, làn; bấm làn để sửa điểm uốn'],
  ['junction', '＋ Ngã tư', 'Bấm vào chỗ trống để đặt ngã tư'],
  ['station', '＋ Trạm', 'Bấm vào chỗ trống để đặt trạm'],
  ['connect', 'Vẽ làn', 'Bấm điểm đầu, các điểm uốn, rồi điểm cuối'],
]

/** Thanh công cụ nổi ở đáy canvas bản đồ AGV (cùng kiểu thanh công cụ của trang Sơ đồ): công cụ sửa, thu phóng, bật tắt bảng bên và bảng dữ liệu. */
export function MapToolbar(p: {
  editing: boolean; tool: MapTool; onTool: (t: MapTool) => void; bothWays: boolean; onBothWays: (b: boolean) => void
  onZoomBy: (factor: number) => void; onFit: () => void
  panelOpen: boolean; onPanel: () => void; tableOpen: boolean; onTable: () => void
  /** Cách đáy bao nhiêu (CSS), để né bảng dữ liệu đang mở. */
  bottom: string
  /** Bề rộng (px) tấm chi tiết đang đè lên mép phải: thanh công cụ căn giữa phần còn lại thay vì nằm dưới tấm. */
  rightInset?: number
}) {
  return (
    <div role="toolbar" aria-label="Công cụ bản đồ" className="absolute z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-panel p-1 shadow-lg" style={{ bottom: p.bottom, left: `calc((100% - ${p.rightInset ?? 0}px) / 2)` }}>
      <Btn label="Bảng điều khiển (đội xe, khung toạ độ)" active={p.panelOpen} onClick={p.onPanel}><PanelLeft size={14} />Bảng</Btn>
      {p.editing && (
        <>
          <Sep />
          {TOOLS.map(([t, label, hint]) => (
            <Btn key={t} label={hint} active={p.tool === t} onClick={() => p.onTool(t)}>{label}</Btn>
          ))}
          {p.tool === 'connect' && (
            <label className="ml-1 flex flex-none items-center gap-1 whitespace-nowrap px-1 text-[11px] text-muted">
              <input type="checkbox" checked={p.bothWays} onChange={(e) => p.onBothWays(e.target.checked)} /> hai chiều
            </label>
          )}
        </>
      )}
      <Sep />
      <Btn label="Thu nhỏ" onClick={() => p.onZoomBy(1 / 1.3)}><Minus size={14} /></Btn>
      <Btn label="Phóng to" onClick={() => p.onZoomBy(1.3)}><Plus size={14} /></Btn>
      <Btn label="Vừa khung" onClick={p.onFit}><Maximize size={14} /></Btn>
      <Sep />
      <Btn label="Bảng điểm, làn và hiệu chỉnh thời gian chuyến" active={p.tableOpen} onClick={p.onTable}><Table2 size={14} />Điểm và làn</Btn>
    </div>
  )
}
