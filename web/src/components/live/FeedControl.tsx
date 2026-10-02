import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { Frame } from '../../api/types'
import { useFeedStatus } from '../../hooks/useLive'
import { SPEEDS, fmtFactoryTime, speedLabel } from '../../lib/liveFormat'
import { ConfirmDialog } from '../ConfirmDialog'
import { ErrorBox, Notice, btn, btnDangerOutline, btnOk, input } from '../ui'

/**
 * Hệ toạ độ hãng xe giả lập cho demo: milimét, trục xoay 90°, gốc lệch khỏi gốc bản đồ. Bật nó thì vị trí xe lệch hẳn khỏi các làn
 * cho tới khi người dùng căn chỉnh khung toạ độ (thẻ "Khung toạ độ xe" ở trang Bản đồ AGV); không biết làn nên API tự khớp xe vào làn.
 */
export const DEMO_CONTROLLER_FRAME: Frame & { noise_m: number } = { dx: -6, dy: 70, rot_deg: -90, scale: 0.001, flip_y: false, noise_m: 0.05 }

/** Thanh điều khiển feed (bộ phát dữ liệu giả lập): bật/tạm dừng, tốc độ giờ nhà máy, đặt lại. */
export function FeedControl({ model, offerFrame = false }: { model: string; /** Cho chọn bật hệ toạ độ hãng xe giả lập khi bắt đầu (chỉ trang Bản đồ AGV cần) */ offerFrame?: boolean }) {
  const qc = useQueryClient()
  const status = useFeedStatus()
  const [speed, setSpeed] = useState<number>(10)
  const [confirmReset, setConfirmReset] = useState(false)
  const [skewed, setSkewed] = useState(false)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['feed-status'] })
    void qc.invalidateQueries({ queryKey: ['live', model] })
  }
  const start = useMutation({ mutationFn: () => api.feed.start(model, speed, skewed ? DEMO_CONTROLLER_FRAME : undefined), onSuccess: refresh })
  const pause = useMutation({ mutationFn: () => api.feed.pause(), onSuccess: refresh })
  const resume = useMutation({ mutationFn: () => api.feed.resume(), onSuccess: refresh })
  const setSpeedM = useMutation({ mutationFn: (x: number) => api.feed.speed(x), onSuccess: refresh })
  const reset = useMutation({ mutationFn: () => api.feed.reset(model), onSuccess: () => { setConfirmReset(false); refresh() } })

  if (status.isError) {
    return (
      <Notice tone="lock">
        Chưa nối được feed service, tức bộ phát dữ liệu giả lập. Bật bằng lệnh <code className="text-text">docker compose up -d feed</code> rồi tải lại trang.
        <span className="ml-1 text-faint">({status.error instanceof Error ? status.error.message : 'lỗi không rõ'})</span>
      </Notice>
    )
  }
  const s = status.data
  if (!s) return null
  const mine = s.model === model
  const err = start.error ?? pause.error ?? resume.error ?? setSpeedM.error
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-text">
        <i className={`h-2 w-2 rounded-full ${s.state === 'running' ? 'animate-pulse bg-ok' : s.state === 'paused' ? 'bg-warn' : 'bg-faint'}`} />
        {s.state === 'idle' ? 'Feed chưa chạy' : s.state === 'paused' ? 'Feed tạm dừng' : 'Feed đang phát'}
      </span>
      {s.state !== 'idle' && (
        <span className="text-muted">
          {mine ? '' : <>mô hình <b className="text-text">{s.model}</b> · </>}giờ nhà máy <b className="tabular-nums text-text">{fmtFactoryTime(s.virtual_now)}</b>
          {mine && s.frame && <span className="ml-2 rounded border border-line-2 px-1.5 py-0.5 text-[11px] text-text-2">hãng xe giả lập báo toạ độ riêng (mm, trục xoay)</span>}
          {s.last_error && <span className="ml-2 text-bad-text">đang lỗi khi gửi dữ liệu tới API: {s.last_error}</span>}
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {(s.state === 'idle' || !mine) && (
          <>
            <select className={input} aria-label="Tốc độ giờ nhà máy" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((x) => <option key={x} value={x}>{speedLabel(x)}</option>)}
            </select>
            {offerFrame && (
              <label className="flex items-center gap-1.5 text-muted" title="Feed phát vị trí xe ở hệ toạ độ riêng (mm, trục xoay) như hãng xe thật; căn chỉnh khung toạ độ để xe vào đúng làn.">
                <input type="checkbox" checked={skewed} onChange={(e) => setSkewed(e.target.checked)} /> Hãng xe báo toạ độ riêng
              </label>
            )}
            <button className={btnOk} disabled={start.isPending} onClick={() => start.mutate()}>
              <Play size={12} /> {s.state === 'idle' ? 'Bắt đầu phát dữ liệu giả lập' : `Chuyển sang ${model}`}
            </button>
          </>
        )}
        {s.state !== 'idle' && mine && (
          <>
            <select className={input} aria-label="Tốc độ giờ nhà máy" value={s.speed} onChange={(e) => setSpeedM.mutate(Number(e.target.value))}>
              {[...new Set<number>([...SPEEDS, s.speed])].sort((a, b) => a - b).map((x) => <option key={x} value={x}>{speedLabel(x)}</option>)}
            </select>
            {s.state === 'running'
              ? <button className={btn} disabled={pause.isPending} onClick={() => pause.mutate()}><Pause size={12} /> Tạm dừng</button>
              : <button className={btnOk} disabled={resume.isPending} onClick={() => resume.mutate()}><Play size={12} /> Tiếp tục</button>}
          </>
        )}
        <button className={btnDangerOutline} onClick={() => setConfirmReset(true)}><RotateCcw size={12} /> Đặt lại</button>
      </span>
      {err ? <div className="basis-full"><ErrorBox error={err} /></div> : null}
      <ConfirmDialog
        open={confirmReset} title="Đặt lại dữ liệu live?" pending={reset.isPending} error={reset.error} confirmLabel="Đặt lại"
        description={<>Dừng feed và xoá toàn bộ dữ liệu live đã ghi của mô hình <b>{model}</b> (giá trị, sự kiện). Ghép nối và bản đồ AGV được giữ nguyên.</>}
        onConfirm={() => reset.mutate()} onCancel={() => setConfirmReset(false)}
      />
    </div>
  )
}
