import { useQuery } from '@tanstack/react-query'
import { Cpu } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { Asset, NodeType } from '../../api/types'
import { ItemIdentity, roleColor } from '../NodeIdentity'
import { EmptyState, SearchBox, Tag, btn } from '../ui'
import { FormDialog } from '../FormDialog'
import { AssetDialog } from './AssetDialog'

/**
 * Chọn thiết bị để đặt lên sơ đồ. Node không còn tự sinh mã: mỗi node là một thiết bị có thật trong
 * danh mục Thiết bị, nên đặt lên sơ đồ là chọn trong danh mục (hoặc khai thiết bị mới ngay tại đây).
 * `onPick` nhận thiết bị đã chọn; `used` là các mã đã có trên sơ đồ (không cho đặt hai lần).
 */
export function AssetPicker({ type, used, onPick, onClose }: {
  type: NodeType
  used: string[]
  onPick: (asset: Asset) => void
  onClose: () => void
}) {
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets })
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const onCanvas = useMemo(() => new Set(used), [used])
  // Chỉ thiết bị đúng loại vừa chọn, chưa ngừng dùng và chưa có trên sơ đồ này.
  const list = (assets.data ?? [])
    .filter((a) => a.node_type === type.code && !a.retired && !onCanvas.has(a.key))
    .filter((a) => q.trim() === '' || `${a.key} ${a.name}`.toLowerCase().includes(q.trim().toLowerCase()))
  const chosen = list.find((a) => a.key === picked)
  return (
    <>
      {creating && (
        <AssetDialog
          onClose={() => setCreating(false)}
          onSaved={(key) => { setCreating(false); setPicked(key) }}
        />
      )}
      <FormDialog
        open={!creating} title={`Đặt ${type.name} lên sơ đồ`} width={520}
        description="Chọn thiết bị có thật trong danh mục. Một thiết bị dùng được ở nhiều mô hình: tham số và tín hiệu của nó khai một lần, mô hình nào cũng dùng."
        submitLabel="Đặt lên sơ đồ" pending={false} canSubmit={chosen !== undefined}
        onSubmit={() => chosen && onPick(chosen)} onClose={onClose}
      >
        <div className="flex items-center justify-between gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Tìm thiết bị" className="w-full" />
          <button type="button" className={btn} onClick={() => setCreating(true)}>Thiết bị mới</button>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-md border border-line">
          {list.length === 0 ? (
            <EmptyState title={`Chưa có thiết bị loại ${type.code} nào dùng được`} icon={Cpu}>
              {q ? 'Thử từ khoá khác.' : 'Bấm "Thiết bị mới" để khai một máy loại này, rồi đặt nó lên sơ đồ.'}
            </EmptyState>
          ) : (
            <ul>
              {list.map((a) => (
                <li key={a.key}>
                  <button
                    type="button" aria-pressed={a.key === picked}
                    onClick={() => setPicked(a.key)}
                    onDoubleClick={() => onPick(a)}
                    className={`flex w-full items-center gap-2 border-b border-line px-2 py-1.5 text-left last:border-b-0 ${a.key === picked ? 'bg-accent/10' : 'hover:bg-panel'}`}
                  >
                    <ItemIdentity icon={Cpu} name={a.name || a.key} code={a.name ? a.key : undefined} color={roleColor(a.archetype)} size={24} />
                    {[a.plant, a.line].filter(Boolean).length > 0 && <Tag>{[a.plant, a.line].filter(Boolean).join(' / ')}</Tag>}
                    {a.models.length > 0 && <span className="flex-none text-[11px] text-faint">{a.models.length} mô hình</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {chosen && (
          <p className="text-faint">
            Mã node trên sơ đồ sẽ là <span className="font-mono text-text-2">{chosen.key}</span>
            {chosen.models.length > 0 ? ` — thiết bị này cũng đang ở ${chosen.models.join(', ')}.` : '.'}
          </p>
        )}
      </FormDialog>
    </>
  )
}
