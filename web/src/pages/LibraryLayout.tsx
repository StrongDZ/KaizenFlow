import { NavLink, Outlet } from 'react-router-dom'

const LINKS = [
  { to: '/library/node-types', label: 'Loại node' },
  { to: '/library/materials', label: 'Vật tư' },
]

/** Panel phụ chỉ để điều hướng (spec §3.1); mục đang chọn chỉ đổi nền. */
export default function LibraryLayout() {
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[170px] flex-none border-r border-line bg-panel-2 p-2 print:hidden">
        <h6 className="px-2.5 pb-2 pt-3 text-[11px] font-semibold text-faint">Thư viện</h6>
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `mb-0.5 block rounded-lg px-2.5 py-1.5 text-xs font-medium ${isActive ? 'bg-raised font-semibold text-text' : 'text-text-2 hover:text-text'}`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  )
}
