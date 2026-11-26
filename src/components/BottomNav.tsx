import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: '首頁', icon: '🏠' },
  { to: '/transactions', label: '明細', icon: '📋' },
  { to: '/reports', label: '報表', icon: '📊' },
  { to: '/accounts', label: '帳戶', icon: '💳' },
  { to: '/settings', label: '設定', icon: '⚙️' },
] as const;

export function BottomNav() {
  return (
    <nav
      aria-label="主導覽列"
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95"
    >
      <div className="mx-auto grid max-w-[720px] grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`
            }
          >
            <span className="text-lg leading-none" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
