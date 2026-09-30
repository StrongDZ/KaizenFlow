import type { Archetype } from '../../api/types'
import { ARCHETYPE_LABEL } from '../KfNode'
import { NodeIcon } from '../nodeIcons'

const DESCRIPTION: Record<Archetype, string> = {
  SOURCE: 'Nơi hàng bắt đầu vào sơ đồ: nhà cung cấp, cửa nhận hàng.',
  STORAGE: 'Nơi hàng nằm chờ: kho kệ, supermarket, buffer giữa hai máy.',
  PROCESS: 'Nơi hàng được xử lý: máy dập, cell lắp ráp, kiểm tra, đóng gói.',
  SINK: 'Nơi hàng kết thúc: cửa xuất hàng, phế phẩm.',
  RESOURCE_POOL: 'Xe hoặc người dùng chung để chở hàng: xe kéo, AGV, người móc kéo.',
}

/** Chọn vai trò của loại node bằng thẻ có mô tả, thay cho ô chọn chỉ có tên ngắn. */
export function ArchetypePicker({ value, onChange, disabled }: { value: Archetype; onChange: (a: Archetype) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Vai trò của loại node" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {(Object.keys(DESCRIPTION) as Archetype[]).map((a) => (
        <button
          key={a} type="button" role="radio" aria-checked={value === a} disabled={disabled} onClick={() => onChange(a)}
          className={`flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left disabled:opacity-60 ${value === a ? 'border-accent bg-panel-2' : 'border-line hover:bg-panel-2'}`}
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-text"><NodeIcon archetype={a} size={13} />{ARCHETYPE_LABEL[a]}</span>
          <span className="text-[10.5px] leading-snug text-muted">{DESCRIPTION[a]}</span>
        </button>
      ))}
    </div>
  )
}
