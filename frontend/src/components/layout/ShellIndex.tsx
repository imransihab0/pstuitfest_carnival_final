export function ShellIndex() {
  return (
    <section aria-labelledby="shell-title" className="max-w-2xl">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Foundation</p>
      <h1 id="shell-title" className="text-balance text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
        The application shell is ready.
      </h1>
      <p className="mt-6 max-w-prose text-base leading-7 text-muted">
        Feature routes will be added here as the wallet workflows are implemented.
      </p>
      <div className="mt-10 border-y border-line py-5" aria-label="Money typography example">
        <span className="block text-xs uppercase tracking-widest text-muted">Money format</span>
        <span className="money mt-2 block text-2xl font-medium text-ink">৳100,000.00</span>
      </div>
    </section>
  )
}
