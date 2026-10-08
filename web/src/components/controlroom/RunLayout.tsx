import { useMemo, useState } from 'react'
import { Link, Outlet, useLocation, useParams } from 'react-router-dom'
import { useParentRun } from '../../hooks/useParentRun'
import { useRunBundle } from '../../hooks/useRunBundle'
import { fmtDateTime } from '../../lib/format'
import { candidatesOf } from '../../lib/insights'
import { isTabActive, runTabs } from '../../lib/nav'
import { ShellContext, useShell } from '../shell/ShellContext'
import { StatusChip } from '../ui'

/**
 * Khung chung của mọi trang trong một lần chạy: dải tab ngay dưới header (Control Room, Cảm biến, Đề xuất, So với gốc, Báo cáo),
 * bên phải là trạng thái lần chạy và các nút của trang đang mở. Nút của trang đi vào đây thay vì header chung,
 * để mọi thứ thuộc lần chạy nằm một chỗ.
 */
export default function RunLayout() {
  const runId = Number(useParams().id)
  const { pathname } = useLocation()
  const shell = useShell()
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)
  const { run, scenario } = useRunBundle(runId, false)
  const parent = useParentRun(scenario.data?.parent_id)
  const recommendations = (run.data?.insights ?? []).filter((i) => i.kind === 'RECOMMENDATION').reduce((n, i) => n + candidatesOf(i).length, 0)
  const tabs = runTabs(runId, { recommendations, compare: parent !== undefined })
  const value = useMemo(() => ({ ...shell, actionsEl }), [shell, actionsEl])
  const s = scenario.data

  return (
    <div className="flex h-full min-h-0 flex-col print:block print:h-auto">
      <div className="flex h-10 flex-none items-stretch gap-4 border-b border-line bg-panel-2 px-3 print:hidden">
        <nav aria-label={`Các phần của lần chạy #${runId}`} className="-mb-px flex items-stretch gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const active = isTabActive(t, pathname)
            return (
              <Link
                key={t.to} to={t.to} aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[12.5px] ${
                  active ? 'border-accent font-semibold text-text' : 'border-transparent text-muted hover:text-text'
                }`}
              >
                {t.label}
                {t.count !== undefined && (
                  <span className={`rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums leading-4 ${active ? 'bg-accent text-on-accent' : 'bg-raised text-text-2'}`}>{t.count}</span>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {run.data && (
            <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted">
              <StatusChip status={run.data.status} />
              {s && <span className="hidden truncate xl:inline">{s.replications} lần lặp, {Math.round(s.horizon_s / 3600)} giờ mô phỏng, bắt đầu {fmtDateTime(run.data.sim_start)}</span>}
            </span>
          )}
          <div ref={setActionsEl} className="flex flex-none items-center gap-2 empty:hidden" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto print:overflow-visible">
        <ShellContext.Provider value={value}>
          <Outlet />
        </ShellContext.Provider>
      </div>
    </div>
  )
}
