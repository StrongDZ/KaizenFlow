import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '../../gauge.css'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { GAUGE_API_BASE } from '../../api/gauge'

const TABS = [
  { label: 'Trực tiếp', to: '/gauge-twin', active: (path: string) => !path.startsWith('/gauge-twin/cameras') },
  { label: 'Camera và khai báo', to: '/gauge-twin/cameras', active: (path: string) => path.startsWith('/gauge-twin/cameras') },
]

/** Khung của mọi trang gauge-twin: đặt token và font riêng của khu này (gauge.css), và hai mục của khu. */
export function GaugeArea({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div className="gt">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-6 py-5">
        <nav aria-label="Mục của khu Đồng hồ" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              aria-current={t.active(pathname) ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-full px-4 text-sm ${t.active(pathname) ? 'bg-accent font-bold text-on-accent' : 'bg-panel text-text-2 hover:bg-raised'}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {children}
      </div>
    </div>
  )
}

/** Lỗi của một thao tác ghi (lưu camera, lưu config): câu chính và từng chi tiết config-api trả về. */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null
  const details = (error as { details?: string[] }).details ?? []
  return (
    <div role="alert" className="rounded-lg border border-bad px-3.5 py-2.5 text-sm">
      <p className="font-bold text-bad">{error instanceof Error ? error.message : String(error)}</p>
      {details.length > 0 && <ul className="mt-1 list-disc pl-5 text-text-2">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  )
}

/** Kiểu chung của ô nhập và nút trong khu này. */
export const gtField = 'min-h-11 w-full rounded-lg border border-line-2 bg-panel-2 px-3 text-sm text-text placeholder:text-faint'
export const gtButton = 'min-h-11 rounded-lg border border-line-2 bg-panel px-4 text-sm text-text hover:border-muted disabled:cursor-not-allowed disabled:opacity-50'
export const gtPrimary = 'min-h-11 rounded-lg bg-accent px-4 text-sm font-bold text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'

/** Băng báo query-api không trả lời; dữ liệu lần gần nhất vẫn nằm trên màn hình. */
export function ApiDownBanner({ error }: { error: unknown }) {
  return (
    <div role="alert" className="rounded-lg border border-bad px-4 py-3 text-sm text-text">
      <span className="font-bold text-bad">Không nối được query-api</span>
      <span className="text-muted"> tại {GAUGE_API_BASE}. Số liệu bên dưới là lần nhận gần nhất. </span>
      <span className="font-mono text-xs text-faint">{error instanceof Error ? error.message : String(error)}</span>
    </div>
  )
}
