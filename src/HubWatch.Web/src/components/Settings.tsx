import { useRef, useState } from 'react'
import { api } from '../api'
import type { Status, SystemStatus } from '../types'
import { formatDateTime } from '../format'
import { AlertSettingsCard } from './AlertSettingsCard'
import { BridgeFinder, type FinderKind } from './BridgeFinder'
import { getTheme, setTheme, type Theme } from '../theme'
import { isConnecting, systemLabel, useReconnect } from '../systems'
import { Spinner, SystemStateText } from './Spinner'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'

const KIND_LABELS: Record<string, string> = { hue: 'Philips Hue Bridge', dirigera: 'IKEA DIRIGERA hub' }
const NATIVE_ID_LABELS: Record<string, string> = { hue: 'Bridge ID', dirigera: 'Hub ID' }

const ADD_TEXT: Record<FinderKind, { title: string; intro: string }> = {
  hue: {
    title: 'Add a Hue Bridge',
    intro: "HubWatch records all connected systems at the same time. Adding one doesn't change the ones you already have.",
  },
  dirigera: {
    title: 'Add an IKEA DIRIGERA hub',
    intro:
      "HubWatch records all connected systems at the same time. Adding one doesn't change the ones you already have. " +
      'The hub must be set up in the IKEA Home smart app first.',
  },
}

export function Settings({ status }: { status: Status }) {
  const [busy, setBusy] = useState(false)
  const [deleteData, setDeleteData] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [removing, setRemoving] = useState<SystemStatus | null>(null)
  const removeDialog = useRef<HTMLDialogElement>(null)
  const [trusting, setTrusting] = useState<SystemStatus | null>(null)
  const trustDialog = useRef<HTMLDialogElement>(null)
  const addDialog = useRef<HTMLDialogElement>(null)
  // The finder is only mounted while the dialog is open, so it searches afresh each time and
  // closing the dialog stops any pairing in progress.
  const [adding, setAdding] = useState(false)
  const [addKind, setAddKind] = useState<FinderKind>('hue')

  const knownBridges = status.systems.filter((s) => s.kind === addKind).map((s) => ({ ip: s.address, id: s.nativeId }))

  function chooseTheme(t: Theme) {
    setTheme(t)
    setThemeState(t)
  }

  function openRemove(system: SystemStatus) {
    setRemoving(system)
    setDeleteData(false)
    setError(null)
    removeDialog.current?.showModal()
  }

  function openTrust(system: SystemStatus) {
    setTrusting(system)
    setError(null)
    trustDialog.current?.showModal()
  }

  async function trust() {
    if (!trusting) return
    setBusy(true)
    setError(null)
    try {
      await api.trustCertificate(trusting.id)
      trustDialog.current?.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function openAdd(kind: FinderKind) {
    setAddKind(kind)
    setAdding(true)
    addDialog.current?.showModal()
  }

  function closeAdd() {
    addDialog.current?.close()
  }

  async function remove() {
    if (!removing) return
    setBusy(true)
    setError(null)
    try {
      await api.removeSystem(removing.id, deleteData)
      removeDialog.current?.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reconnecting = useReconnect()

  return (
    <div className="page narrow">
      <div className="card">
        <h2>Systems</h2>
        <ul className="system-list">
          {status.systems.map((system) => (
            <li key={system.id}>
              <div className="system-head">
                <div>
                  <strong>{systemLabel(system)}</strong>
                  <span className="muted small"> · {KIND_LABELS[system.kind] ?? system.kind}</span>
                </div>
                <button className="danger small-button" disabled={busy} onClick={() => openRemove(system)}>
                  Disconnect
                </button>
              </div>
              <dl className="facts">
                <dt>IP address</dt>
                <dd>{system.address}</dd>
                {system.nativeId && (
                  <>
                    <dt>{NATIVE_ID_LABELS[system.kind] ?? 'ID'}</dt>
                    <dd>{system.nativeId}</dd>
                  </>
                )}
                <dt>Connection</dt>
                <dd>
                  <SystemStateText state={system.state} />
                  {system.message ? ` – ${system.message}` : ''}
                  {isConnecting(system.state) && (
                    <button
                      className="secondary small-button inline-stop"
                      disabled={reconnecting.pending.includes(system.id)}
                      onClick={() => void reconnecting.stop(system.id)}
                    >
                      Stop
                    </button>
                  )}
                </dd>
                <dt>Connected since</dt>
                <dd>{system.connectedSince ? formatDateTime(system.connectedSince) : '–'}</dd>
                <dt>Certificate</dt>
                <dd>{system.certificatePinned ? 'Pinned' : 'Pinned on the next connection'}</dd>
              </dl>
              {system.state === 'offline' && (
                <div className="notice">
                  <p>
                    <strong>HubWatch has stopped trying to reach it.</strong> This is normal when you are on another
                    network or it is switched off.
                  </p>
                  <button
                    className="secondary small-button"
                    disabled={busy || reconnecting.pending.includes(system.id)}
                    onClick={() => void reconnecting.reconnect(system.id)}
                  >
                    {reconnecting.pending.includes(system.id) ? (
                      <>
                        <Spinner />
                        Reconnecting…
                      </>
                    ) : (
                      'Try again'
                    )}
                  </button>
                  {reconnecting.error && <p className="state-error small">{reconnecting.error}</p>}
                </div>
              )}
              {system.problem === 'certificate_changed' && (
                <div className="notice">
                  <p>
                    <strong>Its security certificate has changed.</strong> HubWatch stopped talking to it so its key
                    isn't sent to the wrong device.
                  </p>
                  <button className="secondary small-button" disabled={busy} onClick={() => openTrust(system)}>
                    Trust the new certificate…
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="row-inline">
          <button className="secondary" disabled={busy} onClick={() => openAdd('hue')}>
            Add Hue Bridge…
          </button>
          <button className="secondary" disabled={busy} onClick={() => openAdd('dirigera')}>
            Add IKEA DIRIGERA hub…
          </button>
        </div>
      </div>

      <dialog
        ref={addDialog}
        className="dialog dialog-wide"
        aria-labelledby="add-bridge-title"
        onClose={() => setAdding(false)}
      >
        <h2 id="add-bridge-title">{ADD_TEXT[addKind].title}</h2>
        <p className="muted small">{ADD_TEXT[addKind].intro}</p>
        {adding && (
          <BridgeFinder
            key={addKind}
            kind={addKind}
            known={knownBridges}
            onPaired={closeAdd}
            secondaryAction={<button onClick={closeAdd}>Cancel</button>}
          />
        )}
      </dialog>

      <dialog
        ref={removeDialog}
        className="dialog"
        aria-labelledby="disconnect-title"
        onCancel={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <h2 id="disconnect-title">Disconnect {removing ? systemLabel(removing) : 'system'}?</h2>
        <p className="muted">
          HubWatch stops recording {removing ? systemLabel(removing) : 'it'} and forgets it. Lights, scenes and settings
          on it are not changed. Other systems keep recording.
        </p>
        <label className="dialog-option">
          <input
            type="checkbox"
            checked={deleteData}
            disabled={busy}
            onChange={(e) => setDeleteData(e.target.checked)}
          />
          <span>
            <strong>Also delete all data for it</strong>
            <span className="muted small">Events, readings, sessions and alerts. This can't be undone.</span>
          </span>
        </label>
        {!deleteData && (
          <p className="muted small">Logged history is kept and shows up again if you connect it later.</p>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={() => removeDialog.current?.close()}>
            Cancel
          </button>
          <button className="danger-solid" disabled={busy} onClick={remove}>
            {busy ? 'Working…' : deleteData ? 'Disconnect and delete' : 'Disconnect'}
          </button>
        </div>
      </dialog>

      <dialog
        ref={trustDialog}
        className="dialog"
        aria-labelledby="trust-title"
        onCancel={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <h2 id="trust-title">Trust the new certificate for {trusting ? systemLabel(trusting) : 'this system'}?</h2>
        <p className="muted">
          A bridge or hub rarely gets a new certificate: usually only after a major firmware update or a factory reset. If
          neither happened, another device on your network may be pretending to be the bridge.
        </p>
        <p className="muted small">
          Only trust it if you know why the certificate changed. Otherwise check its IP address in the Hue or IKEA app.
        </p>
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={() => trustDialog.current?.close()}>
            Cancel
          </button>
          <button className="danger-solid" disabled={busy} onClick={trust}>
            {busy ? 'Working…' : 'Trust new certificate'}
          </button>
        </div>
      </dialog>

      <div className="card">
        <h2>Appearance</h2>
        <div className="setting-row">
          <span>Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(
              [
                ['system', 'System', Monitor],
                ['light', 'Light', Sun],
                ['dark', 'Dark', Moon],
              ] as [Theme, string, LucideIcon][]
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                role="radio"
                aria-checked={theme === value}
                className={theme === value ? 'active' : ''}
                onClick={() => chooseTheme(value)}
              >
                <Icon aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">System follows your computer's light or dark setting.</p>
      </div>

      <AlertSettingsCard />

      <div className="card">
        <h2>About</h2>
        <p className="muted">
          HubWatch {status.version}. Events are only recorded while the app is running. Open source under the MIT
          license.
        </p>
      </div>
    </div>
  )
}
