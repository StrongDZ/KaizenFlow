import { leafPaths } from '../../lib/livePath'

/**
 * Các trường của một bản tin mẫu, mỗi dòng là đường dẫn cùng giá trị hiện có. Có `onPick` thì mỗi dòng có nút để chọn trường đó.
 * Dùng ở trang Nguồn dữ liệu (xem bản tin) và hộp Ghép nối (chọn trường).
 */
export function SampleTree({ sample, onPick, pickLabel = 'Ghép', selected }: {
  sample: unknown; onPick?: (path: string) => void; pickLabel?: string; selected?: string
}) {
  const leaves = leafPaths(sample, 80)
  if (sample === undefined || sample === null) return <p className="text-xs text-muted">Chưa có bản tin mẫu nào.</p>
  if (leaves.length === 0) return <p className="text-xs text-muted">Bản tin mẫu không có trường nào để ghép (chỉ có đối tượng hoặc danh sách rỗng).</p>
  return (
    <ul className="divide-y divide-line/60 text-[11.5px]">
      {leaves.map((l) => (
        <li key={l.path} className={`flex items-center gap-2 py-1 ${selected === l.path ? 'bg-panel' : ''}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-text-2" title={l.path || '(giá trị)'}>{l.path || '(giá trị)'}</span>
          <b className="max-w-[45%] truncate tabular-nums text-text" title={String(l.value)}>{String(l.value)}</b>
          {onPick && <button type="button" className="text-accent underline decoration-dotted hover:opacity-80" onClick={() => onPick(l.path)}>{pickLabel}</button>}
        </li>
      ))}
    </ul>
  )
}
