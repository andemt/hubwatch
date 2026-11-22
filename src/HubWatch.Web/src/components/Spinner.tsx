import { LoaderCircle } from 'lucide-react'
import type { SystemState } from '../types'
import { SYSTEM_STATE_LABELS, isConnecting } from '../systems'

/** A small spinning circle that shows something is in progress (it stands still with reduced motion). */
export function Spinner() {
  return <LoaderCircle className="spinner" aria-hidden />
}

/** A system's connection state as coloured text, with a spinner while it is (re)connecting. */
export function SystemStateText({ state }: { state: SystemState }) {
  const busy = isConnecting(state)
  return (
    <span className={`state-text state-${state}`}>
      {busy && <Spinner />}
      {SYSTEM_STATE_LABELS[state]}
    </span>
  )
}
