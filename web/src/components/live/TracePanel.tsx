import { useState } from 'react'
import { Wand2 } from 'lucide-react'
import { api } from '../../api/client'
import type { AgvMap } from '../../api/types'
import { loadGray } from '../../lib/loadGray'
import { traceFree, type Trace } from '../../lib/traceMap'
import { btn, btnPrimary, input } from '../ui'

type Params = { freeIs: 'light' | 'dark'; auto: boolean; threshold: number; minWidthM: number; spurM: number; speckM2: number; fragmentM: number; excludeOutside: boolean }
const DEFAULTS: Params = { freeIs: 'light', auto: true, threshold: 128, minWidthM: 1.5, spurM: 3, speckM2: 0.5, fragmentM: 10, excludeOutside: true }

const num = (v: string, fallback: number) => { const n = Number(v.replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : fallback }

/**
 * Mục "Dò đường từ ảnh" của bảng bên: từ ảnh mặt bằng đã hiệu chuẩn, đề xuất các đường hai chiều (xem trước nét đứt trên bản đồ) để người
 * dùng thêm vào bản đồ rồi sửa tay. Chỉ tốt với ảnh sạch (tường tối, sàn sáng); vùng cấm đã vẽ được loại khỏi vùng đi được.
 */
export function TracePanel({ model, map, preview, onPreview, onApply }: {
  model: string; map: AgvMap; preview: Trace | null; onPreview: (t: Trace | null) => void; onApply: () => void
}) {
  const bg = map.bg
  const [p, setP] = useState<Params>(DEFAULTS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!bg) return null

  const run = async () => {
    setBusy(true)
    setError(null)
    onPreview(null)
    try {
      const { gray, scale } = await loadGray(api.agvMapImageUrl(model, bg.rev))
      await new Promise((r) => setTimeout(r, 0))  // cho trình duyệt vẽ chữ "Đang dò…" trước khi tính
      const t = traceFree(gray, {
        mPerPx: bg.m_per_px / scale, origin: { x: bg.x, y: bg.y }, rotDeg: bg.rot, freeIs: p.freeIs, threshold: p.auto ? undefined : p.threshold,
        minWidthM: p.minWidthM, spurM: p.spurM, minComponentM: p.fragmentM, simplifyM: 0.3, excludeOutside: p.excludeOutside, keepouts: map.keepouts,
        minSpeckPx: Math.max(4, Math.round(p.speckM2 / ((bg.m_per_px / scale) ** 2))),
      })
      onPreview(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không dò được')
    } finally {
      setBusy(false)
    }
  }

  const total = preview ? preview.edges.reduce((a, e) => a + e.lengthM, 0) : 0
  return (
    <div className="space-y-2 text-xs text-text-2">
      {!bg.calibrated && <p className="text-lock-text">Hiệu chuẩn tỉ lệ ảnh trước: bề rộng lối đi tính theo mét nên cần tỉ lệ đúng.</p>}
      <p className="text-[11px] leading-relaxed text-muted">Đề xuất các đường từ ảnh; chỉ tốt với ảnh sạch (tường tối, sàn sáng). Kết quả là bản nháp, bạn xem rồi mới thêm vào bản đồ.</p>
      <p className="text-[11px] leading-relaxed text-muted">Mặt bằng minh hoạ nhiều ký hiệu máy, chữ, màu thường cho kết quả kém: thử tăng "Xe rộng tối thiểu" lên 3 m để chỉ giữ lối đi lớn, hoặc vẽ tay đường trên ảnh nền.</p>
      <label className="block space-y-1"><span className="block">Sàn đi được là vùng</span>
        <select className={`${input} w-full`} value={p.freeIs} onChange={(e) => setP({ ...p, freeIs: e.target.value as Params['freeIs'] })}>
          <option value="light">sáng (tường, máy là nét tối)</option><option value="dark">tối (tường, máy là nét sáng)</option>
        </select></label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-1">Xe rộng tối thiểu <input className={`${input} w-14`} inputMode="decimal" defaultValue={p.minWidthM} onBlur={(e) => setP({ ...p, minWidthM: num(e.target.value, p.minWidthM) })} /> m</label>
        <label className="flex items-center gap-1">Bỏ nhánh cụt &lt; <input className={`${input} w-14`} inputMode="decimal" defaultValue={p.spurM} onBlur={(e) => setP({ ...p, spurM: num(e.target.value, p.spurM) })} /> m</label>
        <label className="flex items-center gap-1" title="Bỏ các đoạn đường rời khỏi mạng chính mà tổng dài dưới mức này (mảnh vụn do ký hiệu, chữ).">Bỏ mảnh rời &lt; <input className={`${input} w-14`} inputMode="decimal" defaultValue={p.fragmentM} onBlur={(e) => setP({ ...p, fragmentM: num(e.target.value, p.fragmentM) })} /> m</label>
        <label className="flex items-center gap-1" title="Chữ, ký hiệu, cột nhỏ hơn diện tích này coi như không có. Tăng lên nếu chữ trong lối đi làm đường vòng quanh chữ.">Bỏ chi tiết &lt; <input className={`${input} w-14`} inputMode="decimal" defaultValue={p.speckM2} onBlur={(e) => setP({ ...p, speckM2: num(e.target.value, p.speckM2) })} /> m²</label>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={p.excludeOutside} onChange={(e) => setP({ ...p, excludeOutside: e.target.checked })} />Bỏ phần ngoài tường ngoài</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={p.auto} onChange={(e) => setP({ ...p, auto: e.target.checked })} />Tự chọn ngưỡng sáng/tối
        {!p.auto && <input type="range" min={1} max={254} value={p.threshold} onChange={(e) => setP({ ...p, threshold: Number(e.target.value) })} aria-label="Ngưỡng sáng tối" />}</label>
      <div className="flex gap-1.5">
        <button className={btn} disabled={busy || !bg.calibrated} onClick={() => void run()}><Wand2 size={13} className="mr-1 inline" />{busy ? 'Đang dò…' : preview ? 'Dò lại' : 'Dò đường'}</button>
        {preview && <button className={btn} onClick={() => onPreview(null)}>Bỏ bản nháp</button>}
      </div>
      {error && <p role="alert" className="text-bad-text">{error}</p>}
      {preview && preview.edges.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-line p-2">
          <p>Đề xuất <b className="text-text">{preview.edges.length}</b> đường, <b className="text-text">{preview.nodes.length}</b> ngã tư, tổng dài khoảng <b className="text-text">{Math.round(total)} m</b> (nét đứt trên bản đồ).</p>
          {map.lanes.length > 0 && <p className="text-lock-text">Bản đồ đã có {map.lanes.length} làn; kết quả sẽ được thêm vào, không thay thế.</p>}
          <button className={btnPrimary} onClick={onApply}>Thêm vào bản đồ</button>
        </div>
      )}
      {preview && preview.edges.length === 0 && <p className="text-lock-text">{preview.note ?? 'Không dò được đường nào.'}</p>}
    </div>
  )
}
