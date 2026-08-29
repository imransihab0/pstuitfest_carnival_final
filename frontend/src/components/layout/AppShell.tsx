import { Outlet } from 'react-router-dom'

export function AppShell() {
  return (
    <div className="min-h-dvh bg-canvas text-charcoal">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="border-b border-line">
        <div className="mx-auto flex min-h-16 max-w-content items-center justify-between px-5 sm:px-8">
          <span className="text-sm font-semibold uppercase tracking-[0.18em]">PSTU Money</span>
          <span className="text-xs font-medium uppercase tracking-widest text-muted">Wallet</span>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-content px-5 py-12 sm:px-8 sm:py-16">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-content border-t border-line px-5 py-6 text-xs text-muted sm:px-8">
        Closed-loop simulated funds · Values shown in BDT
      </footer>
    </div>
  )
}
