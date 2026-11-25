import { useState } from 'react'
import { BridgeFinder, type FinderKind } from './BridgeFinder'

const KINDS: { kind: FinderKind; label: string }[] = [
  { kind: 'hue', label: 'Philips Hue' },
  { kind: 'dirigera', label: 'IKEA DIRIGERA' },
]

const INTRO: Record<FinderKind, string> = {
  hue: 'Connect to your Philips Hue Bridge to start logging.',
  dirigera: 'Connect to your IKEA DIRIGERA hub to start logging. The hub must be set up in the IKEA Home smart app first.',
}

export function Setup({ onPaired }: { onPaired: () => void }) {
  const [kind, setKind] = useState<FinderKind>('hue')
  // Hidden while pairing: switching system would cancel it.
  const [busy, setBusy] = useState(false)

  return (
    <div className="setup">
      <div className="card setup-card">
        <h1>
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={28} height={28} /> HubWatch
        </h1>
        {!busy && (
          <>
            <div className="setup-tabs" role="tablist" aria-label="System to connect">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  role="tab"
                  aria-selected={kind === k.kind}
                  className={kind === k.kind ? 'active' : ''}
                  onClick={() => setKind(k.kind)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <p className="muted">
              {INTRO[kind]} You can add more bridges and hubs later in Settings. Everything stays on your local network.
            </p>
          </>
        )}
        {/* Keyed on the kind so switching starts a fresh search and stops any pairing in progress. */}
        <BridgeFinder key={kind} kind={kind} onPaired={onPaired} onBusyChange={setBusy} />
      </div>
    </div>
  )
}
