import { Outlet } from 'react-router-dom'

export function AuthLayout() {
  return (
    <div className="grid min-h-dvh bg-canvas text-charcoal lg:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)]">
      <aside className="hidden border-r border-line bg-charcoal p-12 text-canvas lg:flex lg:flex-col lg:justify-between">
        <span className="text-sm font-semibold uppercase tracking-[0.18em]">PSTU Money</span>
        <div className="max-w-md">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-line">Closed-loop wallet</p>
          <p className="mt-5 text-4xl font-medium leading-tight tracking-tight">
            Money movement with a ledger you can trust.
          </p>
        </div>
        <p className="text-xs text-line">Simulated funds · Values in BDT</p>
      </aside>
      <main className="flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <span className="mb-12 block text-sm font-semibold uppercase tracking-[0.18em] lg:hidden">PSTU Money</span>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
