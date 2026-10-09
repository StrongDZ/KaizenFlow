import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { GAUGE_API_BASE } from '../../api/gauge'
import { btn, btnPrimary, input } from '../ui'

/** Khung nội dung của các trang khu Đồng hồ. Điều hướng Trạm / Camera nằm ở panel phụ, như mọi mục khác. */
export function GaugeArea({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-6">{children}</div>
}

/** Lỗi của một thao tác ghi (lưu camera, lưu config): câu chính và từng chi tiết config-api trả về. */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null
  const details = (error as { details?: string[] }).details ?? []
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg px-3 py-2 text-xs text-bad-text">
      <p className="font-medium">{error instanceof Error ? error.message : String(error)}</p>
      {details.length > 0 && <ul className="mt-1 list-disc pl-5">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  )
}

/** Kiểu chung của ô nhập và nút trong khu này: dùng đúng kiểu của cả app. */
export const gtField = `${input} w-full`
export const gtButton = btn
export const gtPrimary = btnPrimary

/** Băng báo query-api không trả lời; dữ liệu lần gần nhất (nếu có) vẫn nằm trên màn hình. */
export function ApiDownBanner({ error }: { error: unknown }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg px-3 py-2 text-xs text-text-2">
      <b className="font-semibold text-bad-text">Không nối được dịch vụ đọc đồng hồ</b> (query-api tại {GAUGE_API_BASE}).
      {' '}Số liệu trên màn hình là lần nhận gần nhất. Trên máy chủ, chạy <code className="rounded bg-panel px-1">make server-up</code> trong thư mục gauge-twin.
      <span className="ml-1 text-muted">{error instanceof Error ? error.message : String(error)}</span>
    </div>
  )
}

/**
 * Ba bước để có trạm đầu tiên, theo đúng thứ tự phải làm. Hiện khi chưa có trạm nào gửi số đọc, để người mới biết bắt đầu từ đâu.
 * `done`: số bước đã xong (đã có camera thì bước 1 xong…).
 */
export function GaugeSetupSteps({ done = 0 }: { done?: number }) {
  const steps = [
    { title: 'Khai báo camera', detail: 'Nhập địa chỉ luồng hình (RTSP) của camera nhìn vào tủ máy, bấm Thử để thấy hình rồi lưu.', to: '/gauge-twin/cameras', action: 'Mở danh sách camera' },
    { title: 'Khoanh từng đồng hồ', detail: 'Mở camera, kéo chuột quanh mỗi đồng hồ, chọn máy và loại đồng hồ, chấm thang đo, đọc thử cho đúng rồi lưu.' },
    { title: 'Theo dõi ở đây', detail: 'Khi edge ở máy bắt đầu gửi số đọc, trạm hiện trong danh sách này; trạm cần xem đứng đầu, kèm việc nên kiểm tra.' },
  ]
  return (
    <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.title} className="flex flex-col gap-1 bg-panel p-4">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-text">
            <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] tabular-nums ${i < done ? 'bg-ok-solid text-on-ok' : i === done ? 'bg-accent text-on-accent' : 'bg-raised text-muted'}`}>{i + 1}</span>
            {s.title}
          </span>
          <span className="text-xs leading-5 text-text-2">{s.detail}</span>
          {s.to && i === done && <Link to={s.to} className={`${btnPrimary} mt-1 self-start`}>{s.action}</Link>}
        </li>
      ))}
    </ol>
  )
}
