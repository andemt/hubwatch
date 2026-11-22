import type { SystemEvent } from '../types'
import { categoryOf, CATEGORIES, formatDay, formatTime } from '../format'
import { useSystemName } from '../systems'
import { CategoryIcon } from '../icons'
import { Drawer, PropertyTable } from './Drawer'

const EVENT_TYPES: Record<string, string> = {
  update: 'Update',
  add: 'Added',
  delete: 'Removed',
  error: 'Error',
  backfill: 'While closed',
}

export function EventDrawer({ event: e, onClose }: { event: SystemEvent; onClose: () => void }) {
  const systemName = useSystemName()
  const cat = categoryOf(e.resourceType)
  const title = e.name ?? e.resourceType.replace(/_/g, ' ')
  const subtitle =
    [e.room !== e.name ? e.room : null, systemName(e.systemId)].filter(Boolean).join(' · ') || CATEGORIES[cat].label

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose}>
      <dl className="facts">
        <dt>What</dt>
        <dd>{e.summary}</dd>
        <dt>When</dt>
        <dd>
          {formatDay(e.ts)} · {formatTime(e.ts)}
        </dd>
        <dt>Category</dt>
        <dd>
          <span className="event-cat">
            <CategoryIcon category={cat} /> {CATEGORIES[cat].label}
          </span>
        </dd>
        <dt>Event</dt>
        <dd>{EVENT_TYPES[e.eventType] ?? e.eventType}</dd>
        {e.origin === 'hubwatch' && (
          <>
            <dt>Origin</dt>
            <dd>Switched from HubWatch</dd>
          </>
        )}
        <dt>Resource</dt>
        <dd>{e.resourceType.replace(/_/g, ' ')}</dd>
        <dt>Resource id</dt>
        <dd>
          <code>{e.resourceId}</code>
        </dd>
      </dl>

      {e.eventType === 'backfill' && (
        <p className="muted small">Happened while the app was not running. The time is the one reported by the bridge.</p>
      )}

      <PropertyTable title="Data from the bridge" json={e.data} empty="This event has no readable data." />
    </Drawer>
  )
}
