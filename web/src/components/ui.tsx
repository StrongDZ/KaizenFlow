import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import type { Issue, RunStatus } from '../api/types'

export const btn = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50'
export const btnPrimary = 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'

export function Loading() {
  return <div className="p-6 text-sm text-slate-500">Đang tải…</div>
}

export function issuesOf(e: unknown): Issue[] {
  return e instanceof ApiError ? e.issues : []
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  const issues = issuesOf(error)
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
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

export function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </div>
  )
}

const STATUS: Record<RunStatus, string> = {
  QUEUED: 'bg-slate-200 text-slate-700',
  RUNNING: 'bg-blue-100 text-blue-700',
  DONE: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
}

export function StatusChip({ status }: { status: RunStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[status]}`}>{status}</span>
}

export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}
