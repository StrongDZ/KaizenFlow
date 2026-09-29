import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import type { Issue, RunStatus } from '../api/types'
import { statusLabel } from '../lib/format'

export const btn =
  'inline-flex items-center gap-1.5 rounded-lg border border-line-2 px-3 py-1.5 text-xs font-medium text-text-2 hover:bg-panel hover:text-text disabled:cursor-not-allowed disabled:opacity-50'
export const btnPrimary =
  'inline-flex items-center gap-1.5 rounded-lg bg-text px-3 py-1.5 text-xs font-semibold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
export const input =
  'rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1.5 text-xs text-text placeholder:text-faint'

export function Loading() {
  return <div className="p-6 text-xs text-muted">Đang tải…</div>
}

export function issuesOf(e: unknown): Issue[] {
  return e instanceof ApiError ? e.issues : []
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  const issues = issuesOf(error)
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg p-3 text-xs text-bad-text">
      <div className="font-medium">{msg}</div>
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((i) => (
            <li key={i.key + i.message}>
              <b>{i.key}</b>: {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DOT: Record<RunStatus, string> = {
  QUEUED: 'bg-faint',
  RUNNING: 'bg-text animate-pulse',
  DONE: 'bg-ok',
  FAILED: 'bg-bad',
}

export function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-2 py-0.5 text-[11px] text-text-2">
      <i className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      {statusLabel(status)}
    </span>
  )
}

export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-xs font-semibold text-text">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-1 p-8 text-center">
      <div className="text-sm font-semibold text-text">{title}</div>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
    </div>
  )
}
