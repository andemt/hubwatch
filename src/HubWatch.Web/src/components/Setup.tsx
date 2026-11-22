import { BridgeFinder } from './BridgeFinder'

export function Setup({ onPaired }: { onPaired: () => void }) {
  return (
    <div className="setup">
      <div className="card setup-card">
        <h1>
          <img src="/favicon.svg" alt="" width={28} height={28} /> HubWatch
        </h1>
        <p className="muted">
          Connect to your Philips Hue Bridge to start logging. You can add more bridges later in Settings. Everything stays on your local network.
        </p>
        <BridgeFinder onPaired={onPaired} />
      </div>
    </div>
  )
}
