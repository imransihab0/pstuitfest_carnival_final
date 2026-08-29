export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty-state" aria-live="polite" aria-busy="true">{label}</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <p>{message}</p>
      {onRetry && <button className="mt-2 font-semibold underline underline-offset-4" type="button" onClick={onRetry}>Try again</button>}
    </div>
  )
}
