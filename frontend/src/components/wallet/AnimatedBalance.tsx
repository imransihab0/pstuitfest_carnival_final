import { useEffect, useRef, useState } from 'react'
import { formatPoisha } from '../../lib/money'

const DURATION_MS = 650
const PRECISION = 1_000_000n

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function AnimatedBalance({ balancePoisha }: { balancePoisha: string }) {
  const target = BigInt(balancePoisha)
  const renderedValue = useRef(target)
  const [displayed, setDisplayed] = useState(target)

  useEffect(() => {
    const start = renderedValue.current
    if (start === target || prefersReducedMotion()) {
      renderedValue.current = target
      setDisplayed(target)
      return
    }

    let frame = 0
    let startedAt: number | undefined
    const difference = target - start

    const tick = (now: number) => {
      startedAt ??= now
      const progress = Math.min((now - startedAt) / DURATION_MS, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const scaledProgress = BigInt(Math.round(eased * Number(PRECISION)))
      const next = start + (difference * scaledProgress) / PRECISION

      renderedValue.current = next
      setDisplayed(next)

      if (progress < 1) {
        frame = window.requestAnimationFrame(tick)
      } else {
        renderedValue.current = target
        setDisplayed(target)
      }
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [target])

  return (
    <>
      <span aria-hidden="true">{formatPoisha(displayed)}</span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Available balance {formatPoisha(target)}
      </span>
    </>
  )
}
