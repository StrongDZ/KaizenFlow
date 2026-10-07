import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { isRowEnter, nextSort, sortRows, type Sort } from '../../lib/table'

export type Column<T> = {
  key: string
  header: string
  cell: (row: T) => ReactNode
  sort?: (row: T) => string | number | null
  align?: 'left' | 'right'
  className?: string
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, empty, initialSort, flat, selected }: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string | number
  onRowClick?: (row: T) => void
  empty?: ReactNode
  initialSort?: Sort
  /** Bảng nằm trong một Card: bỏ viền riêng để không thành hộp trong hộp. */
  flat?: boolean
  /** Dòng đang được chọn (hiện nền nhạt), cho bảng có khung chi tiết bên cạnh. */
  selected?: (row: T) => boolean
}) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null)
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key)
    return sortRows(rows, col?.sort, sort?.dir ?? 'asc')
  }, [rows, columns, sort])
  if (rows.length === 0 && empty) return <>{empty}</>
  const onKey = (e: KeyboardEvent, row: T) => {
    if (onRowClick && isRowEnter(e.key, e.target, e.currentTarget)) onRowClick(row)
  }
  return (
    <div className={`overflow-x-auto ${flat ? '' : 'rounded-xl border border-line'}`}>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                className={`border-b border-line px-3 py-2 text-[11px] font-medium text-muted ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.sort ? (
                  <button className="inline-flex items-center gap-1 hover:text-text" onClick={() => setSort(nextSort(sort, c.key))}>
                    {c.header}
                    {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => onKey(e, row) : undefined}
              aria-selected={selected?.(row) || undefined}
              className={`border-b border-line/60 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-panel' : ''} ${selected?.(row) ? 'bg-panel' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.className ?? ''}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
