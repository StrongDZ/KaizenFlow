import { Bot, Cog, Hammer, Inbox, Package, PackageCheck, Puzzle, Scan, Search, Send, Store, Tractor, Trash2, Truck, User, Users, Warehouse, type LucideIcon } from 'lucide-react'

/** Tên biểu tượng trong ui.icon của loại node (services/api/internal/catalog/builtin.go) sang biểu tượng lucide. */
const BY_NAME: Record<string, LucideIcon> = {
  truck: Truck, search: Search, warehouse: Warehouse, store: Store, inbox: Inbox, hammer: Hammer, puzzle: Puzzle,
  scan: Scan, package: Package, send: Send, trash: Trash2, tractor: Tractor, bot: Bot, user: User,
}

/** Loại tự tạo chưa có biểu tượng thì lấy theo vai trò trong sơ đồ. */
const BY_ARCHETYPE: Record<string, LucideIcon> = {
  SOURCE: Truck, STORAGE: Warehouse, PROCESS: Cog, SINK: PackageCheck, RESOURCE_POOL: Users,
}

export function NodeIcon({ name, archetype, size = 14, className }: { name?: string; archetype?: string; size?: number; className?: string }) {
  const Icon = (name && BY_NAME[name]) || (archetype && BY_ARCHETYPE[archetype]) || Cog
  return <Icon size={size} className={className} aria-hidden />
}
