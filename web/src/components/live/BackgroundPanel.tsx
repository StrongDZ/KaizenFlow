import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, ImagePlus, Move, RotateCcw, RotateCw, Ruler, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import type { AgvMap, MapBG, Pt } from '../../api/types'
import { bounds } from '../../lib/mapGeom'
import { calibrateBg, defaultBg, rotateBg, scaleBg } from '../../lib/mapImage'
import { prepareImage } from '../../lib/prepareImage'
import { btn, btnPrimary, input } from '../ui'

/** Ô số chỉ áp dụng khi rời ô hay bấm Enter, để gõ dở ("1", "12") không làm ảnh co giãn từng phím. */
function CommitNumber({ label, value, unit, onCommit, step }: { label: string; value: number; unit: string; onCommit: (n: number) => void; step?: number }) {
  const shown = String(Math.round(value * 100) / 100).replace('.', ',')
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => { const n = Number(text.replace(',', '.')); if (Number.isFinite(n)) onCommit(n); else setText(shown) }
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="flex-none text-[11px] text-muted">{label}</span>
      <input className={`${input} w-full min-w-0 tabular-nums`} inputMode="decimal" step={step} value={text} aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
      <span className="flex-none text-[11px] text-muted">{unit}</span>
    </label>
  )
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return <span title={title} className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] tabular-nums text-text-2">{children}</span>
}

/** Bản đồ chưa có gì thì đoán ảnh rộng 100 m; đã có điểm thì đoán ảnh rộng hơn chút so với phần đã vẽ. Hiệu chuẩn sẽ sửa lại cho đúng. */
function widthGuess(map: AgvMap): number {
  if (map.points.length === 0) return 100
  return Math.max(bounds({ ...map, bg: undefined }, 0).w * 1.2, 40)
}

/**
 * Mục "Ảnh nền" của bảng bên: tải ảnh mặt bằng, hiệu chuẩn tỉ lệ bằng hai điểm đã biết khoảng cách, chỉnh độ mờ và vị trí.
 * Ảnh đi lên server ngay khi chọn; chỗ đặt và tỉ lệ (`bg`) chỉ nằm trong bản đồ đang sửa, thành thật khi bấm Lưu bản đồ.
 */
export function BackgroundPanel({ model, map, editing, opacity, onOpacity, onChange, calib, onCalib, adjusting = false, onAdjust }: {
  model: string; map: AgvMap; editing: boolean; opacity: number; onOpacity: (n: number) => void
  onChange: (bg: MapBG | undefined) => void
  /** Đang chỉnh ảnh trên bản đồ (khung có núm dời, đổi cỡ, xoay). */
  adjusting?: boolean; onAdjust?: (on: boolean) => void
  /** Hai điểm đã bấm để hiệu chuẩn; null là không đang hiệu chuẩn. */
  calib: Pt[] | null; onCalib: (c: Pt[] | null) => void
}) {
  const bg = map.bg
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dist, setDist] = useState('')

  const pick = async (f: File | undefined) => {
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const { blob } = await prepareImage(f)
      const up = await api.uploadAgvMapImage(model, blob)
      onCalib(null)
      onChange(defaultBg(up.width, up.height, widthGuess(map), up.rev))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được ảnh')
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }

  const apply = () => {
    const d = Number(dist.replace(',', '.'))
    if (!bg || !calib || calib.length < 2 || !(d > 0)) return
    onChange(calibrateBg(bg, calib[0], calib[1], d))
    onCalib(null)
    setDist('')
  }

  const picker = (
    <>
      <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void pick(e.target.files?.[0])} />
      <button className={btn} disabled={busy} onClick={() => file.current?.click()}><ImagePlus size={13} className="mr-1 inline" />{bg ? 'Thay ảnh' : 'Tải ảnh mặt bằng'}</button>
    </>
  )

  if (!bg) {
    return (
      <div className="space-y-2 text-xs text-text-2">
        {editing ? (
          <>
            <p className="text-[11px] leading-relaxed text-muted">Tải ảnh mặt bằng (PNG, JPEG) để vẽ đường lên trên; sau đó hiệu chuẩn tỉ lệ bằng hai điểm đã biết khoảng cách.</p>
            {picker}
          </>
        ) : <p className="text-[11px] text-muted">Chưa có ảnh nền. Bấm "Sửa bản đồ" để tải ảnh mặt bằng.</p>}
        {busy && <p className="text-muted">Đang thu nhỏ và tải ảnh lên…</p>}
        {error && <p role="alert" className="text-bad-text">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2 text-xs text-text-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{Math.round(bg.w_px * bg.m_per_px)} × {Math.round(bg.h_px * bg.m_per_px)} m</Chip>
        <Chip title={`${bg.w_px}×${bg.h_px} px`}>{bg.m_per_px.toFixed(3).replace('.', ',')} m/px</Chip>
        {!bg.calibrated && <span className="flex items-center gap-1 text-[11px] font-medium text-lock-text"><CircleAlert size={13} aria-hidden />Kích thước đang là ước đoán</span>}
      </div>
      <label className="flex items-center gap-2.5">
        <span className="flex-none text-[11px] text-muted">Độ đậm</span>
        <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" aria-label="Độ đậm của ảnh nền" />
        <span className="w-8 flex-none text-right text-[11px] tabular-nums text-text-2">{Math.round(opacity * 100)}%</span>
      </label>
      {!editing && onAdjust && (
        <button className={btn} onClick={() => onAdjust(true)} title="Bắt đầu sửa bản đồ và chỉnh ảnh"><Move size={13} aria-hidden />Chỉnh ảnh (dời, đổi cỡ, xoay)</button>
      )}
      {editing && (
        <>
          {adjusting ? (
            <div className="space-y-2 rounded-lg bg-accent/8 p-2">
              <p className="text-[11px] leading-snug text-text-2">Kéo trong khung để dời ảnh, kéo một góc để đổi cỡ, kéo núm tròn để xoay (giữ Shift: bước 15°).</p>
              <div className="flex gap-2">
                <CommitNumber label="Rộng" unit="m" value={bg.w_px * bg.m_per_px} onCommit={(w) => { if (w > 0) onChange(scaleBg(bg, w / (bg.w_px * bg.m_per_px))) }} />
                <CommitNumber label="Xoay" unit="°" value={bg.rot ?? 0} onCommit={(d) => onChange(rotateBg(bg, d))} />
              </div>
              <div className="flex gap-2">
                <CommitNumber label="Góc X" unit="m" value={bg.x} onCommit={(x) => onChange({ ...bg, x })} />
                <CommitNumber label="Y" unit="m" value={bg.y} onCommit={(y) => onChange({ ...bg, y })} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button className={btn} onClick={() => onChange(rotateBg(bg, (bg.rot ?? 0) - 90))} title="Xoay 90° ngược chiều kim đồng hồ"><RotateCcw size={13} aria-hidden />90°</button>
                <button className={btn} onClick={() => onChange(rotateBg(bg, (bg.rot ?? 0) + 90))} title="Xoay 90° theo chiều kim đồng hồ"><RotateCw size={13} aria-hidden />90°</button>
                {(bg.rot ?? 0) !== 0 && <button className={btn} onClick={() => onChange(rotateBg(bg, 0))}>Bỏ xoay</button>}
                <button className={`${btnPrimary} ml-auto`} onClick={() => onAdjust?.(false)}><Check size={13} aria-hidden />Xong</button>
              </div>
              <p className="text-[10.5px] text-faint">Đổi cỡ bằng tay bỏ dấu đã hiệu chuẩn; dời và xoay thì không.</p>
            </div>
          ) : calib === null ? (
            <div className="flex flex-wrap gap-1.5">
              {onAdjust && <button className={btn} onClick={() => { onCalib(null); onAdjust(true) }}><Move size={13} aria-hidden />Chỉnh ảnh</button>}
              <button className={btn} onClick={() => { onAdjust?.(false); onCalib([]); setDist('') }}><Ruler size={13} className="mr-1 inline" />Hiệu chuẩn tỉ lệ</button>
              {picker}
              <button className={btn} onClick={() => { onCalib(null); onAdjust?.(false); onChange(undefined) }}><Trash2 size={13} className="mr-1 inline" />Xoá ảnh</button>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-md border border-line p-2">
              <p className="text-[11px] leading-relaxed">
                {calib.length < 2
                  ? `Bấm hai điểm trên ảnh có khoảng cách đã biết (một cột tới cột kia, bề rộng một lối đi). Đã bấm ${calib.length}/2.`
                  : 'Nhập khoảng cách thật giữa hai điểm vừa bấm.'}
              </p>
              {calib.length >= 2 && (
                <label className="flex items-center gap-1.5"><span>Khoảng cách thật</span>
                  <input className={`${input} w-20`} inputMode="decimal" autoFocus value={dist} placeholder="vd. 12,5" onChange={(e) => setDist(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') apply() }} /> m</label>
              )}
              <div className="flex gap-1.5">
                <button className={btnPrimary} disabled={calib.length < 2 || !(Number(dist.replace(',', '.')) > 0)} onClick={apply}>Áp dụng</button>
                <button className={btn} onClick={() => onCalib(null)}>Huỷ</button>
              </div>
            </div>
          )}
        </>
      )}
      {busy && <p className="text-muted">Đang thu nhỏ và tải ảnh lên…</p>}
      {error && <p role="alert" className="text-bad-text">{error}</p>}
    </div>
  )
}
