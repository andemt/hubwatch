import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PowerTarget } from '../types'

/** How long to show the requested state while waiting for the system to report it back. */
const SETTLE_MS = 5000

/**
 * Switches one or more lights, rooms or zones on or off (several when a room exists in more than one system).
 * The shown state follows `on` from the system; right after a click it shows the requested state until the
 * system reports it, or until SETTLE_MS has passed.
 */
export function PowerSwitch({ on, targets, label }: { on: boolean | null; targets: PowerTarget[]; label: string }) {
  const [wanted, setWanted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  // The system reported a state: stop showing the requested one.
  useEffect(() => {
    if (wanted !== null && on === wanted) setWanted(null)
  }, [on, wanted])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const shown = wanted ?? on ?? false

  async function toggle() {
    const next = !shown
    setError(null)
    setBusy(true)
    setWanted(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setWanted(null), SETTLE_MS)

    const results = await Promise.allSettled(targets.map((t) => api.setPower(t.systemId, t.id, next)))
    setBusy(false)
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed.length > 0) {
      window.clearTimeout(timer.current)
      setWanted(null)
      setError(failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join(' '))
    }
  }

  return (
    <span className="power">
      {error && (
        <span className="power-error" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        role="switch"
        className="power-switch"
        aria-checked={shown}
        aria-busy={busy}
        aria-label={label}
        title={`${label}: ${shown ? 'on' : 'off'}`}
        disabled={targets.length === 0}
        onClick={(e) => {
          e.stopPropagation()
          if (!busy) void toggle()
        }}
      />
    </span>
  )
}
