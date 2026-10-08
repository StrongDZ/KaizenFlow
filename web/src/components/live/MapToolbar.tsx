import { BatteryCharging, ImageUp, CircleDot, ListChecks, MapPin, Maximize, Minus, MousePointer2, OctagonX, PanelLeft, Plus, Spline, Table2, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type MapTool = 'select' | 'junction' | 'station' | 'charger' | 'connect' | 'keepout'

const base = 'inline-flex h-7 min-w-7 flex-none items-center whitespace-nowrap justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-text-2 hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'
const on = 'bg-raised text-text'

function Btn({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick} className={`${base} ${active ? on : ''}`}>
      {children}
    </button>
  )
}

const Sep = () => <span aria-hidden className="mx-0.5 h-4 w-px flex-none bg-line-2" />

const TOOLS: [MapTool, string, string, LucideIcon][] = [
  ['select', 'Chọn', 'Chọn và kéo điểm, đường; bấm đường để sửa điểm uốn', MousePointer2],
  ['junction', 'Ngã tư', 'Bấm vào chỗ trống để đặt ngã tư', CircleDot],
  ['station', 'Trạm', 'Bấm vào chỗ trống để đặt trạm', MapPin],
  ['charger', 'Chỗ sạc', 'Bấm vào chỗ trống để đặt chỗ sạc cho AMR; tự nối vào đường gần nhất', BatteryCharging],
  ['connect', 'Vẽ đường', 'Bấm điểm đầu, các điểm uốn, rồi điểm cuối (đường hai chiều)', Spline],
  ['keepout', 'Vùng cấm', 'Bấm các đỉnh của vùng xe không được vào; bấm đỉnh đầu hoặc Enter để khép kín', OctagonX],
]

/**
 * Thanh công cụ nổi ở đáy canvas bản đồ AGV (cùng kiểu thanh công cụ của trang Sơ đồ): công cụ sửa (luôn hiện, bấm khi đang xem là vào chế độ sửa),
 * thu phóng, bật tắt bảng bên và bảng dữ liệu.
 */
export function MapToolbar(p: {
  editing: boolean; tool: MapTool; onTool: (t: MapTool) => void
  onZoomBy: (factor: number) => void; onFit: () => void
  panelOpen: boolean; onPanel: () => void; tableOpen: boolean; onTable: () => void
  factsOn: boolean; onFacts: () => void
  /** Có ảnh nền: nút bật khung chỉnh ảnh (dời, đổi cỡ, xoay). */
  image?: { on: boolean; toggle: () => void }
  /** Cách đáy bao nhiêu (CSS), để né bảng dữ liệu đang mở. */
  bottom: string
  /** Bề rộng (px) tấm chi tiết đang đè lên mép phải: thanh công cụ căn giữa phần còn lại thay vì nằm dưới tấm. */
  rightInset?: number
}) {
  return (
    <div role="toolbar" aria-label="Công cụ bản đồ" className="absolute z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-panel p-1 shadow-lg" style={{ bottom: p.bottom, left: `calc((100% - ${p.rightInset ?? 0}px) / 2)` }}>
      <Btn label="Bảng điều khiển (đội xe, khung toạ độ)" active={p.panelOpen} onClick={p.onPanel}><PanelLeft size={14} />Bảng</Btn>
      <Sep />
      {/* Công cụ sửa luôn hiện; đang xem mà bấm một công cụ thì trang tự vào chế độ sửa với công cụ đó. */}
      {TOOLS.map(([t, label, hint, Icon]) => (
        <Btn key={t} label={p.editing ? hint : `${hint} (bấm để bắt đầu sửa bản đồ)`} active={p.editing && p.tool === t} onClick={() => p.onTool(t)}><Icon size={13} aria-hidden />{label}</Btn>
      ))}
      {p.image && (
        <Btn label={p.editing ? 'Dời, đổi cỡ, xoay ảnh nền' : 'Dời, đổi cỡ, xoay ảnh nền (bấm để bắt đầu sửa bản đồ)'} active={p.image.on} onClick={p.image.toggle}>
          <ImageUp size={13} aria-hidden />Chỉnh ảnh
        </Btn>
      )}
      <Sep />
      <Btn label="Thu nhỏ" onClick={() => p.onZoomBy(1 / 1.3)}><Minus size={14} /></Btn>
      <Btn label="Phóng to" onClick={() => p.onZoomBy(1.3)}><Plus size={14} /></Btn>
      <Btn label="Vừa khung" onClick={p.onFit}><Maximize size={14} /></Btn>
      <Sep />
      <Btn label="Hiện thông số quan trọng của từng node ngay dưới node (trạng thái máy, tồn kho, số đã giao...)" active={p.factsOn} onClick={p.onFacts}><ListChecks size={14} />Thông số</Btn>
      <Btn label="Bảng điểm, làn và hiệu chỉnh thời gian chuyến" active={p.tableOpen} onClick={p.onTable}><Table2 size={14} />Điểm và làn</Btn>
    </div>
  )
}
