import { useEffect, useRef } from 'react'
import type { SystemStatus } from '../types'
import { systemLabel, useReconnect } from '../systems'
import { Spinner } from './Spinner'

interface Props {
  open: boolean
  system: SystemStatus
  onClose: () => void
}

/**
 * Offers to reconnect the only system after HubWatch gave up reaching it (state "offline"). Stays open while it
 * tries, so you can see it working, and closes by itself once it is connected.
 */
export function ReconnectDialog({ open, system, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { reconnect, stop, pending, error } = useReconnect()
  const requesting = pending.includes(system.id)
  const trying = system.state === 'connecting' || system.state === 'reconnecting'

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  useEffect(() => {
    if (open && system.state === 'connected') onClose()
  }, [open, system.state, onClose])

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="reconnect-title" onClose={onClose}>
      {trying ? (
        <>
          <h2 id="reconnect-title">Reconnecting to {systemLabel(system)}</h2>
          <p className="busy-line" role="status">
            <Spinner />
            Trying to reach it at <strong>{system.address}</strong>…
          </p>
          <p className="muted small">
            This can take up to 30 seconds. You can close this; HubWatch keeps trying in the background.
          </p>
          {error && <p className="state-error small">{error}</p>}
          <div className="dialog-actions">
            <button disabled={requesting} onClick={() => void stop(system.id)}>
              Stop
            </button>
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id="reconnect-title">{systemLabel(system)} is offline</h2>
          <p>
            HubWatch could not reach it at <strong>{system.address}</strong> and has stopped trying. This is normal
            when you are on another network or it is switched off.
          </p>
          {system.message && <p className="muted small">{system.message}</p>}
          {error && <p className="state-error small">{error}</p>}
          <div className="dialog-actions">
            <button onClick={onClose}>Close</button>
            <button className="primary" disabled={requesting} onClick={() => void reconnect(system.id)}>
              {requesting ? (
                <>
                  <Spinner />
                  Reconnecting…
                </>
              ) : (
                'Try again'
              )}
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}
