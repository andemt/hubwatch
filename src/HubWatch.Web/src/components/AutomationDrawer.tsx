import type { Automation } from '../types'
import { useSystemName } from '../systems'
import { Drawer, PropertyTable } from './Drawer'

export function AutomationDrawer({ automation: a, onClose }: { automation: Automation; onClose: () => void }) {
  const systemName = useSystemName()
  const targets = [...new Set(a.targets.map((t) => t.name ?? t.type.replace(/_/g, ' ')))]
  const subtitle = [a.script, systemName(a.systemId)].filter(Boolean).join(' · ')

  return (
    <Drawer title={a.name} subtitle={subtitle || undefined} onClose={onClose}>
      {a.lastError && (
        <div className="drawer-alert drawer-alert-bad" role="status">
          <div style={{ gridColumn: '1 / -1' }}>
            <strong>Last error</strong>
            <p>{a.lastError}</p>
          </div>
        </div>
      )}

      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <span className={`tag ${a.enabled ? 'tag-on' : 'tag-off'}`}>{a.enabled ? 'Enabled' : 'Disabled'}</span>
        </dd>
        {a.status && (
          <>
            <dt>State</dt>
            <dd>{a.status.replace(/_/g, ' ')}</dd>
          </>
        )}
        {a.when && (
          <>
            <dt>When</dt>
            <dd>{a.when}</dd>
          </>
        )}
        {targets.length > 0 && (
          <>
            <dt>Applies to</dt>
            <dd>{targets.join(', ')}</dd>
          </>
        )}
        {a.script && (
          <>
            <dt>Type</dt>
            <dd>{a.script}</dd>
          </>
        )}
        {a.category && (
          <>
            <dt>Category</dt>
            <dd>{a.category.replace(/_/g, ' ')}</dd>
          </>
        )}
        {systemName(a.systemId) && (
          <>
            <dt>System</dt>
            <dd>{systemName(a.systemId)}</dd>
          </>
        )}
        <dt>Id</dt>
        <dd>
          <code>{a.id}</code>
        </dd>
      </dl>

      {a.scriptDescription && <p className="muted small">{a.scriptDescription}</p>}

      <PropertyTable title="Configuration" json={a.configuration} empty="This automation has no readable configuration." />
    </Drawer>
  )
}
