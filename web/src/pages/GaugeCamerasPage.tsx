import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { gaugeConfigApi, GAUGE_CONFIG_API_BASE, type CameraDoc } from '../api/gaugeConfig'
import { Plus } from 'lucide-react'
import { ActionError, GaugeArea, gtButton, gtField, gtPrimary } from '../components/gauge/GaugeArea'
import { btnAccentOutline, btnDangerOutline, btnPrimary } from '../components/ui'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-text-2">
      {label}
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

/** Thêm một camera: nhập địa chỉ, bấm Thử để thấy hình, rồi lưu. */
function AddCamera({ taken, onClose }: { taken: string[]; onClose?: () => void }) {
  const qc = useQueryClient()
  const [cameraId, setCameraId] = useState('')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [url, setUrl] = useState('')
  const [fps, setFps] = useState('2')
  const test = useMutation({ mutationFn: () => gaugeConfigApi.frame({ url }) })
  const save = useMutation({
    mutationFn: () => gaugeConfigApi.putCamera(cameraId, { name, location, url, sample_fps: Number(fps) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gauge-config', 'cameras'] })
      setCameraId(''); setName(''); setLocation(''); setUrl(''); test.reset(); onClose?.()
    },
  })
  const exists = taken.includes(cameraId)
  return (
    <section className="flex flex-wrap gap-5 rounded-lg border border-line bg-panel p-4">
      <form
        className="flex min-w-0 flex-[1_1_360px] flex-col gap-3.5"
        onSubmit={(e) => { e.preventDefault(); save.mutate() }}
      >
        <h2 className="text-xs font-semibold">Thêm camera</h2>
        <Field label="Mã camera" hint="Chữ, số, dấu _ . -  Nên trùng nhãn dán trên camera ngoài hiện trường.">
          <input className={`${gtField} tabular-nums`} value={cameraId} onChange={(e) => setCameraId(e.target.value)} placeholder="cam-l01-a" required />
        </Field>
        <Field label="Tên">
          <input className={gtField} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tủ điện máy dập 1" />
        </Field>
        <Field label="Vị trí lắp">
          <input className={gtField} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Dây chuyền L01, phía trước" />
        </Field>
        <Field label="Địa chỉ luồng hình (RTSP)">
          <input className={`${gtField} tabular-nums`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtsp://10.1.3.21/stream1" required />
        </Field>
        <Field label="Số khung hình đọc mỗi giây" hint="Từ 1 đến 30. Đồng hồ đổi chậm thì 2 là đủ.">
          <input className={gtField} type="number" min={1} max={30} value={fps} onChange={(e) => setFps(e.target.value)} required />
        </Field>
        {exists && <p className="text-xs text-warn">Mã này đã có: lưu sẽ sửa camera đó, và các máy đang dùng nó nhận config mới.</p>}
        <ActionError error={save.error} />
        <div className="flex flex-wrap gap-2.5">
          <button type="button" className={gtButton} disabled={!url || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Đang lấy hình…' : 'Thử camera'}
          </button>
          <button type="submit" className={gtPrimary} disabled={save.isPending}>{save.isPending ? 'Đang lưu…' : exists ? 'Lưu thay đổi' : 'Lưu camera'}</button>
          {onClose && <button type="button" className={gtButton} onClick={onClose}>Huỷ</button>}
        </div>
      </form>
      <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-2">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-raised">
          {test.data
            ? <img src={`data:image/jpeg;base64,${test.data.frame_jpeg}`} alt="Khung hình thử từ camera" className="h-full w-full object-contain" />
            : <p className="px-6 text-center tabular-nums text-xs text-faint">
                {test.isPending ? 'Đang kết nối tới camera…' : test.isError ? 'Không lấy được hình từ địa chỉ này.' : 'Bấm “Thử camera” để thấy camera đang quay gì trước khi lưu.'}
              </p>}
        </div>
        {test.data && <p className="tabular-nums text-xs text-muted">{test.data.width}×{test.data.height} · ảnh thử không được lưu lại</p>}
        <ActionError error={test.error} />
      </div>
    </section>
  )
}

function CameraCard({ camera }: { camera: CameraDoc }) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () => gaugeConfigApi.deleteCamera(camera.camera_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gauge-config', 'cameras'] }),
  })
  const gauges = camera.machines.reduce((n, m) => n + m.gauges, 0)
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold">{camera.name || camera.camera_id}</h3>
          <p className="tabular-nums text-xs text-muted">{camera.camera_id}{camera.location && ` · ${camera.location}`}</p>
        </div>
        <span className="flex-none rounded-full bg-raised px-2.5 py-1 tabular-nums text-xs text-text-2">{camera.sample_fps} hình/s</span>
      </div>
      <p className="truncate tabular-nums text-xs text-faint" title={camera.url}>{camera.url}</p>
      {camera.machines.length > 0 ? (
        <div>
          <p className="text-xs text-text-2">Đang đọc {gauges} đồng hồ của {camera.machines.length} máy</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {camera.machines.map((m) => (
              <li key={m.machine_id}>
                <Link to={`/gauge-twin/${encodeURIComponent(m.machine_id)}`} className="rounded-full border border-line-2 px-2.5 py-1 tabular-nums text-xs text-text-2 hover:border-muted">
                  {m.machine_id} · {m.gauges}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-xs text-muted">Chưa có đồng hồ nào trên camera này.</p>}
      <ActionError error={remove.error} />
      <div className="mt-auto flex flex-wrap gap-2.5">
        <Link to={`/gauge-twin/cameras/${encodeURIComponent(camera.camera_id)}`} className={btnAccentOutline}>Khoanh vùng đồng hồ</Link>
        <button
          className={btnDangerOutline}
          disabled={camera.machines.length > 0 || remove.isPending}
          title={camera.machines.length > 0 ? 'Gỡ hết đồng hồ khỏi camera này trước khi xoá' : undefined}
          onClick={() => { if (window.confirm(`Xoá camera ${camera.camera_id}?`)) remove.mutate() }}
        >
          Xoá
        </button>
      </div>
    </li>
  )
}

/** Danh mục camera: mỗi camera khai một lần, không thuộc máy nào; đồng hồ của máy nào cũng có thể nằm trên nó. */
export default function GaugeCamerasPage() {
  const q = useQuery({ queryKey: ['gauge-config', 'cameras'], queryFn: gaugeConfigApi.cameras })
  const [adding, setAdding] = useState(false)
  const empty = q.data !== undefined && q.data.length === 0
  return (
    <GaugeArea>
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-text">Camera</h1>
          <p className="mt-0.5 max-w-3xl text-xs text-muted">
            Một camera có thể nhìn đồng hồ của nhiều máy, một máy có thể cần nhiều camera. Khai báo camera ở đây, rồi mở nó để khoanh từng đồng hồ và chọn đồng hồ đó thuộc máy nào.
          </p>
        </div>
        {!adding && !empty && <button className={btnPrimary} onClick={() => setAdding(true)}><Plus size={13} /> Thêm camera</button>}
      </header>
      {q.isError && (
        <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg px-3 py-2 text-xs text-text-2">
          <b className="font-semibold text-bad-text">Không nối được dịch vụ cấu hình</b> (config-api tại {GAUGE_CONFIG_API_BASE}).{' '}
          <span className="text-muted">{q.error instanceof Error ? q.error.message : ''}</span>
        </div>
      )}
      {(adding || empty) && <AddCamera taken={(q.data ?? []).map((c) => c.camera_id)} onClose={empty ? undefined : () => setAdding(false)} />}
      {q.data && q.data.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
          {q.data.map((c) => <CameraCard key={c.camera_id} camera={c} />)}
        </ul>
      )}
      {q.isPending && <p className="text-xs text-muted">Đang tải danh sách camera…</p>}
    </GaugeArea>
  )
}
