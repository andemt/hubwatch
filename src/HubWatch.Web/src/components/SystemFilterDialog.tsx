import { useEffect, useRef } from 'react'
import type { SystemStatus } from '../types'
import { isConnecting, systemLabel, useReconnect } from '../systems'
import { Spinner, SystemStateText } from './Spinner'

interface Props {
  open: boolean
  systems: SystemStatus[]
  hidden: string[]
  onChange: (hidden: string[]) => void
  onClose: () => void
}

/** Chooses which systems the UI shows. Hidden systems keep recording. */
export function SystemFilterDialog({ open, systems, hidden, onChange, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { reconnect, stop, pending, error } = useReconnect()

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  const shownCount = systems.filter((s) => !hidden.includes(s.id)).length

  function toggle(id: string, show: boolean) {
    onChange(show ? hidden.filter((h) => h !== id) : [...hidden, id])
  }

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="system-filter-title" onClose={onClose}>
      <h2 id="system-filter-title">Show systems</h2>
      <p className="muted small">
        Choose which systems to show. Hidden systems keep recording, so nothing is missed.
      </p>
      <div className="system-filter">
        {systems.map((s) => {
          const shown = !hidden.includes(s.id)
          const last = shown && shownCount === 1
          return (
            <label key={s.id} className="dialog-option neutral" title={last ? 'At least one system must be shown.' : undefined}>
              <input type="checkbox" checked={shown} disabled={last} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span>
                <strong>{systemLabel(s)}</strong>
                <span className="muted small">
                  {s.address} · <SystemStateText state={s.state} />
                </span>
                {s.state === 'offline' && s.message && <span className="muted small">{s.message}</span>}
              </span>
              {s.state === 'offline' && (
                <button
                  className="small-button reconnect-button"
                  disabled={pending.includes(s.id)}
                  onClick={(e) => {
                    e.preventDefault() // don't toggle the checkbox of the surrounding label
                    void reconnect(s.id)
                  }}
                >
                  {pending.includes(s.id) ? (
                    <>
                      <Spinner />
                      Reconnecting…
                    </>
                  ) : (
                    'Reconnect'
                  )}
                </button>
              )}
              {isConnecting(s.state) && (
                <button
                  className="small-button reconnect-button"
                  disabled={pending.includes(s.id)}
                  onClick={(e) => {
                    e.preventDefault() // don't toggle the checkbox of the surrounding label
                    void stop(s.id)
                  }}
                >
                  Stop
                </button>
              )}
            </label>
          )
        })}
      </div>
      {error && <p className="state-error small">{error}</p>}
      <p className="muted small">At least one system must be shown.</p>
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  )
}
