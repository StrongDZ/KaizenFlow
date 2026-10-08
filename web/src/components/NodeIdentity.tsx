import type { ReactNode } from 'react'
import { NodeIcon } from './nodeIcons'

/** Màu vai trò của node (token --color-role-*): nhận ra loại node trước khi đọc chữ. Trạng thái (xanh/vàng/đỏ) không dùng ở đây. */
const ROLE_VAR: Record<string, string> = {
  SOURCE: 'var(--color-role-source)', STORAGE: 'var(--color-role-storage)', PROCESS: 'var(--color-role-process)',
  SINK: 'var(--color-role-sink)', RESOURCE_POOL: 'var(--color-role-pool)',
}
export const roleColor = (archetype?: string) => (archetype && ROLE_VAR[archetype]) || 'var(--color-muted)'

/** Ô biểu tượng vuông bo góc, nền nhạt theo màu vai trò. Đội xe / người vận hành viền nét đứt như trên sơ đồ. */
export function NodeAvatar({ icon, archetype, size = 28 }: { icon?: string; archetype?: string; size?: number }) {
  const c = roleColor(archetype)
  return (
    <span
      aria-hidden
      className={`inline-flex flex-none items-center justify-center rounded-md border ${archetype === 'RESOURCE_POOL' ? 'border-dashed' : ''}`}
      style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, borderColor: `color-mix(in srgb, ${c} 32%, transparent)` }}
    >
      <NodeIcon name={icon} archetype={archetype} size={Math.round(size * 0.54)} />
    </span>
  )
}

/** Biểu tượng bên trái, tên (đậm) và mã node (nhạt) xếp chồng bên phải; `trailing` là phần trạng thái ở mép phải. */
export function NodeIdentity({ name, code, icon, archetype, size = 28, trailing }: {
  name: string; code?: string; icon?: string; archetype?: string; size?: number; trailing?: ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <NodeAvatar icon={icon} archetype={archetype} size={size} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12.5px] font-medium text-text">{name}</span>
        {code && code !== name && <span className="block truncate text-[10.5px] tracking-wide text-faint">{code}</span>}
      </span>
      {trailing}
    </span>
  )
}

/** Như NodeIdentity nhưng cho thứ không phải node (mô hình, vật tư): biểu tượng cho trước, màu cho trước (mặc định màu nhấn). */
export function ItemIdentity({ icon: Icon, name, code, color = 'var(--color-accent)', size = 28, badge }: {
  icon: import('lucide-react').LucideIcon; name: ReactNode; code?: ReactNode; color?: string; size?: number
  /** chấm nhỏ ở góc biểu tượng (vd. đang chạy trực tiếp) */
  badge?: ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <span aria-hidden className="relative inline-flex flex-none items-center justify-center rounded-md"
        style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>
        <Icon size={Math.round(size * 0.52)} />
        {badge}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12.5px] font-medium text-text">{name}</span>
        {code !== undefined && <span className="block truncate text-[10.5px] tracking-wide text-faint">{code}</span>}
      </span>
    </span>
  )
}
