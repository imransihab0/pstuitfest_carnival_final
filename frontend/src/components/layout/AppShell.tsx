import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../lib/auth/useAuth'

export function AppShell() {
  const { user, logout } = useAuth()

  return (
    <div className="min-h-dvh bg-canvas text-charcoal">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="border-b border-line">
        <div className="mx-auto flex min-h-16 max-w-content items-center justify-between gap-4 px-5 sm:px-8">
          <span className="text-sm font-semibold uppercase tracking-[0.18em]">PSTU Money</span>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-muted sm:inline">{user?.name}</span>
            <button className="min-h-11 px-2 text-sm font-semibold text-charcoal underline decoration-line underline-offset-4 hover:decoration-ink" type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-content gap-1 overflow-x-auto px-5 sm:px-8" aria-label="Primary navigation">
          {[
            ['/', 'Dashboard'],
            ['/send', 'Send money'],
            ['/requests', 'Requests'],
            ['/history', 'History'],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${isActive ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="main-content" className="mx-auto min-h-[calc(100dvh-12rem)] max-w-content px-5 py-10 sm:px-8 sm:py-14">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-content border-t border-line px-5 py-6 text-xs text-muted sm:px-8">
        Closed-loop simulated funds · Values shown in BDT
      </footer>
    </div>
  )
}
