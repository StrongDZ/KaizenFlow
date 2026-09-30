import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { rankOptions, type Option } from '../lib/searchSelect'
import { input } from './ui'

type Props = {
  value: string
  options: Option[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Giá trị đang giữ không nằm trong danh sách: viền đỏ và hiện `invalidHint`. */
  invalid?: boolean
  invalidHint?: string
  label?: string
  /** Có thì khi chữ gõ vào chưa trùng mục nào sẽ hiện dòng "+ …" để tạo mới tại chỗ. */
  createLabel?: (typed: string) => string
  onCreate?: (typed: string) => void
  emptyText?: string
  className?: string
}

/**
 * Ô chọn có tìm kiếm: bấm mở danh sách, gõ để lọc (không phân biệt dấu), ↑ ↓ chọn, Enter xác nhận, Esc đóng.
 * Thay cho ô gõ tay với mọi thứ hệ thống đã biết (vật tư, nguồn, trường bản tin, node).
 */
export function SearchSelect({ value, options, onChange, placeholder = 'Chọn…', disabled, invalid, invalidHint, label, createLabel, onCreate, emptyText = 'Không có mục nào khớp.', className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useMemo(() => rankOptions(options, q), [options, q])
  const typed = q.trim()
  const canCreate = !!onCreate && typed !== '' && !options.some((o) => o.value === typed)
  const rows = canCreate ? [...list.map((o) => ({ kind: 'option' as const, o })), { kind: 'create' as const }] : list.map((o) => ({ kind: 'option' as const, o }))
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value)
  const choose = (i: number) => {
    const row = rows[i]
    if (!row) return
    if (row.kind === 'create') onCreate?.(typed)
    else onChange(row.o.value)
    setOpen(false)
  }
  const move = (to: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, to))
    setAt(n)
    requestAnimationFrame(() => listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }))
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(at + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(at - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(at) }
  }
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) { setQ(''); setAt(0) } }}>
      <Popover.Trigger asChild>
        <button
          type="button" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
          style={invalid ? { borderColor: 'var(--color-bad)' } : undefined}
          className={`kf-select ${input} flex w-full items-center justify-between gap-2 text-left disabled:opacity-60 ${className}`}
        >
          <span className={`min-w-0 flex-1 truncate ${value === '' ? 'text-faint' : ''}`}>{value === '' ? placeholder : selected?.label ?? value}</span>
          {selected?.hint && <span className="hidden flex-none truncate text-[10.5px] text-faint sm:inline">{selected.hint}</span>}
          <ChevronDown size={13} className="flex-none text-faint" aria-hidden />
        </button>
      </Popover.Trigger>
      {invalid && invalidHint && <p role="alert" className="mt-1 text-[11px] text-bad-text">{invalidHint}</p>}
      <Popover.Portal>
        <Popover.Content
          align="start" sideOffset={4} collisionPadding={8}
          className="z-[70] w-[max(var(--radix-popover-trigger-width),240px)] overflow-hidden rounded-lg border border-line-2 bg-raised text-xs shadow-xl"
        >
          <div className="border-b border-line p-1.5">
            <input
              autoFocus className={`${input} w-full`} aria-label="Tìm trong danh sách" placeholder="Gõ để tìm"
              value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={onKey}
            />
          </div>
          <ul ref={listRef} role="listbox" className="max-h-[240px] overflow-y-auto p-1">
            {rows.map((row, i) =>
              row.kind === 'create' ? (
                <li key="__create" role="option" aria-selected={i === at}>
                  <button type="button" onMouseMove={() => setAt(i)} onClick={() => choose(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-accent ${i === at ? 'bg-panel' : ''}`}>
                    <Plus size={12} aria-hidden />{createLabel ? createLabel(typed) : `Tạo "${typed}"`}
                  </button>
                </li>
              ) : (
                <li key={row.o.value} role="option" aria-selected={i === at}>
                  <button type="button" onMouseMove={() => setAt(i)} onClick={() => choose(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-text ${i === at ? 'bg-panel' : ''}`}>
                    <span className="flex h-3 w-3 flex-none items-center justify-center">{row.o.value === value && <Check size={12} aria-hidden />}</span>
                    <span className="min-w-0 flex-1 truncate">{row.o.label}</span>
                    {row.o.hint && <span className="flex-none truncate text-[10.5px] text-faint">{row.o.hint}</span>}
                  </button>
                </li>
              ),
            )}
            {rows.length === 0 && <li className="px-2 py-3 text-muted">{emptyText}</li>}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
