import { useEffect, useRef, useState } from 'react'

/**
 * Animated number counter. Ticks from the previous rendered value up to the
 * current target using requestAnimationFrame with an ease-out cubic curve
 * so the count decelerates naturally as it approaches the target.
 *
 * Designed for dashboard headline numbers ("$127/mo") where seeing the value
 * materialize is more delightful than a blink-to-final value. Respects
 * `prefers-reduced-motion` so accessibility users don't get the animation.
 */
export default function CountUp({
  value,                    // target numeric value
  duration = 900,           // animation duration in ms
  decimals = 0,             // decimals to show
  prefix = "$",             // rendered before the number
  suffix = "",              // rendered after
  format = null,            // optional custom formatter (v) => string
}) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef(null)

  useEffect(() => {
    // Respect reduced-motion preference: jump straight to target, no animation.
    const prefersReduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) { setDisplay(value); fromRef.current = value; return }

    const from = fromRef.current
    const to   = Number(value) || 0
    if (from === to) return

    const startTime = performance.now()
    const tick = (t) => {
      const elapsed = t - startTime
      const p = Math.min(1, elapsed / duration)
      // ease-out cubic — starts fast, slows at the end
      const eased = 1 - Math.pow(1 - p, 3)
      const current = from + (to - from) * eased
      setDisplay(current)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else { fromRef.current = to; setDisplay(to) }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [value, duration])

  const fmt = format
    ? format(display)
    : `${prefix}${Number(display).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`
  return <>{fmt}</>
}
