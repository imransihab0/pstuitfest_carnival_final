import { isRouteErrorResponse, useRouteError } from 'react-router-dom'

export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'The application could not load.'

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-5 text-charcoal">
      <section className="max-w-lg border-l-4 border-danger pl-6" role="alert">
        <p className="text-xs font-semibold uppercase tracking-widest text-danger">Error</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">Something went wrong</h1>
        <p className="mt-3 text-muted">{message}</p>
        <a className="mt-6 inline-flex min-h-11 items-center border border-ink px-4 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink" href="/">
          Return home
        </a>
      </section>
    </main>
  )
}
