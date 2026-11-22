import type { SystemStatus } from '../types'
import { formatDateTime } from '../format'
import { systemLabel } from '../systems'

/** Says which shown systems aren't connected, so their devices, rooms and automations read as the last known state. */
export function OfflineNotice({ systems }: { systems: SystemStatus[] }) {
  const notLive = systems.filter((s) => s.state !== 'connected')
  if (notLive.length === 0) return null
  return (
    <div className="notice offline-notice" role="status">
      {notLive.map((s) => (
        <p key={s.id}>
          <strong>{systemLabel(s)} is not connected.</strong>{' '}
          {s.resourcesAsOf
            ? `Its devices, rooms and automations show what it reported last (${formatDateTime(s.resourcesAsOf)}). The real state may differ.`
            : 'Its devices, rooms and automations appear once it connects.'}
        </p>
      ))}
    </div>
  )
}
