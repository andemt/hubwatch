import { useMemo, useEffect, useState } from 'react'
import { api } from '../api'
import type { Automation, Rule, RuleAction, RuleCondition, RulesResponse } from '../types'
import { formatAgo } from '../format'
import { useLiveRefresh } from '../useThrottledRefresh'
import { useSystemName } from '../systems'
import { Clock, MapPin } from 'lucide-react'
import { Collapsible } from './Collapsible'
import { AutomationDrawer } from './AutomationDrawer'
import { encodeRef, usePanelRoute } from '../panelRoute'

const OPERATORS: Record<string, string> = {
  eq: '=',
  gt: '>',
  lt: '<',
  dx: 'changed',
  ddx: 'changed, then held for',
  stable: 'stable for',
  'not stable': 'not stable for',
  in: 'within',
  'not in': 'outside',
}

const keyOf = (a: Automation) => encodeRef(a)

const SCHEDULE = 'Schedule'
/** Automations that start at a time (fixed or sunrise/sunset) are schedules, whatever Hue script runs them. */
function groupOf(a: Automation) {
  return a.when ? SCHEDULE : (a.script ?? 'Other')
}

/** "Only enabled" is kept in the URL (?show=enabled) so a reload or shared link shows the same list. */
function enabledOnlyFromUrl() {
  return new URLSearchParams(window.location.search).get('show') === 'enabled'
}

function writeEnabledOnlyToUrl(on: boolean) {
  const params = new URLSearchParams(window.location.search)
  if (on) params.set('show', 'enabled')
  else params.delete('show')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
}

export function Automations() {
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [rules, setRules] = useState<RulesResponse | null>(null)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const tick = useLiveRefresh((e) => e.resourceType === 'behavior_instance', 3000)
  const systemName = useSystemName()
  const [enabledOnly, setEnabledOnly] = useState(enabledOnlyFromUrl)
  const [openKey, openPanel, closePanel] = usePanelRoute('automation')
  // Looked up in the latest list so the panel follows live updates.
  const openAutomation = openKey ? automations?.find((a) => keyOf(a) === openKey) ?? null : null

  useEffect(() => {
    const onPop = () => setEnabledOnly(enabledOnlyFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function changeEnabledOnly(on: boolean) {
    setEnabledOnly(on)
    writeEnabledOnlyToUrl(on)
  }

  // Grouped across all systems: everything that starts at a time (schedules, wake-ups, go-to-sleep, …)
  // under Schedule, the rest by their Hue script (Motion Sensor, …). Within a group, automations with a
  // clock time are sorted by it, the rest by name; the system only breaks ties.
  const groups = useMemo(() => {
    if (!automations) return null
    const byType = new Map<string, Automation[]>()
    for (const a of automations) {
      if (enabledOnly && !a.enabled) continue
      const type = groupOf(a)
      byType.set(type, [...(byType.get(type) ?? []), a])
    }
    const byTime = (a: Automation, b: Automation) =>
      (a.startMinute ?? Infinity) - (b.startMinute ?? Infinity) ||
      a.name.localeCompare(b.name) ||
      (systemName(a.systemId) ?? '').localeCompare(systemName(b.systemId) ?? '')
    const rank = (type: string) => (type === SCHEDULE ? 0 : type === 'Other' ? 2 : 1)
    return [...byType.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([type, list]) => ({ type, list: [...list].sort(byTime) }))
  }, [automations, systemName, enabledOnly])

  useEffect(() => {
    api.automations().then(setAutomations).catch(() => {})
  }, [tick])

  // A linked automation that doesn't exist (any more), or belongs to a hidden system: drop it from the URL.
  useEffect(() => {
    if (openKey && automations && !automations.some((a) => keyOf(a) === openKey)) closePanel()
  }, [openKey, automations, closePanel])

  function loadRules() {
    setRulesError(null)
    api
      .rules()
      .then(setRules)
      .catch((e: Error) => setRulesError(e.message))
  }
  useEffect(loadRules, [])

  const shownRules = rules?.rules.filter((r) => !enabledOnly || r.status === 'enabled') ?? []
  const shownSchedules = rules?.schedules.filter((s) => !enabledOnly || s.status === 'enabled') ?? []
  const none = (what: string) => `No ${enabledOnly ? 'enabled ' : ''}${what}.`

  return (
    <div className="page">
      <div className="page-actions">
        <label className="check">
          <input type="checkbox" checked={enabledOnly} onChange={(e) => changeEnabledOnly(e.target.checked)} />
          Only enabled
        </label>
      </div>
      <section>
        {groups === null ? (
          <p className="muted">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="muted">{none('automations')}</p>
        ) : (
          groups.map((g) => (
            <Collapsible
              key={g.type}
              id={`automations.${g.type}`}
              title={
                <>
                  {g.type} <span className="muted">· {g.list.length}</span>
                </>
              }
            >
              <div className="stack">
                {g.list.map((a) => (
                  <AutomationCard
                    key={keyOf(a)}
                    automation={a}
                    selected={keyOf(a) === openKey}
                    onOpen={() => openPanel(keyOf(a))}
                  />
                ))}
              </div>
            </Collapsible>
          ))
        )}
      </section>

      <section>
        <div className="section-head">
          <h3>Rules</h3>
          <button className="secondary small-button" onClick={loadRules}>
            Refresh
          </button>
        </div>
        <p className="muted small section-intro">
          The bridge's built-in rule engine. Switches, motion sensors and third-party apps often create these behind the
          scenes.
        </p>
        {rules?.errors.map((e) => (
          <p key={e} className="error small">
            {e}
          </p>
        ))}
        {rulesError ? (
          <p className="error">{rulesError}</p>
        ) : rules === null ? (
          <p className="muted">Loading…</p>
        ) : shownRules.length === 0 ? (
          <p className="muted">{none('rules')}</p>
        ) : (
          <div className="stack">
            {shownRules.map((r) => (
              <RuleCard key={`${r.systemId}-${r.id}`} rule={r} />
            ))}
          </div>
        )}
      </section>

      {shownSchedules.length > 0 && (
        <section>
          <h3>Schedules</h3>
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>When</th>
                  <th>Does</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shownSchedules.map((s) => (
                  <tr key={`${s.systemId}-${s.id}`}>
                    <td>
                      {s.name}
                      {s.description && s.description !== s.name && <div className="muted small">{s.description}</div>}
                    </td>
                    <td>{s.when ?? '–'}</td>
                    <td>{s.command ? <ActionText action={s.command} /> : '–'}</td>
                    <td>
                      <StatusPill enabled={s.status === 'enabled'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openAutomation && (
        <AutomationDrawer key={openKey} automation={openAutomation} onClose={closePanel} />
      )}
    </div>
  )
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return <span className={`tag ${enabled ? 'tag-on' : 'tag-off'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
}

function AutomationCard({
  automation: a,
  selected,
  onOpen,
}: {
  automation: Automation
  selected: boolean
  onOpen: () => void
}) {
  const systemName = useSystemName()
  return (
    <div className={`card automation clickable${a.enabled ? '' : ' disabled'}${selected ? ' selected' : ''}`}>
      <div className="automation-head">
        <div>
          {/* Its click area covers the whole card (see .card-open). */}
          <button type="button" className="card-open" aria-haspopup="dialog" onClick={onOpen}>
            <strong>{a.name}</strong>
          </button>
          {groupOf(a) !== a.script && a.script && <span className="muted"> · {a.script}</span>}
          {systemName(a.systemId) && <span className="muted"> · {systemName(a.systemId)}</span>}
        </div>
        <StatusPill enabled={a.enabled} />
      </div>
      <div className="automation-meta">
        {a.when && (
          <span className="with-icon">
            <Clock aria-hidden /> {a.when}
          </span>
        )}
        {a.targets.length > 0 && (
          <span className="with-icon">
            <MapPin aria-hidden /> {[...new Set(a.targets.map((t) => t.name ?? t.type.replace(/_/g, ' ')))].join(', ')}</span>
        )}
      </div>
      {a.scriptDescription && <p className="muted small">{a.scriptDescription}</p>}
      {a.lastError && <p className="error small">Last error: {a.lastError}</p>}
    </div>
  )
}

function RuleCard({ rule: r }: { rule: Rule }) {
  const systemName = useSystemName()
  return (
    <div className={`card rule${r.status === 'enabled' ? '' : ' disabled'}`}>
      <div className="automation-head">
        <div>
          <strong>{r.name}</strong>
          {systemName(r.systemId) && <span className="muted"> · {systemName(r.systemId)}</span>}
        </div>
        <StatusPill enabled={r.status === 'enabled'} />
      </div>
      <div className="muted small">
        {r.timesTriggered > 0
          ? `Triggered ${r.timesTriggered} time${r.timesTriggered === 1 ? '' : 's'}${r.lastTriggered ? ` · last ${formatAgo(r.lastTriggered)}` : ''}`
          : 'Never triggered'}
      </div>
      <div className="rule-body">
        <div>
          <div className="rule-label">If</div>
          <ul>
            {r.conditions.map((c, i) => (
              <li key={i}>
                <ConditionText condition={c} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="rule-label">Then</div>
          <ul>
            {r.actions.map((a, i) => (
              <li key={i}>
                <ActionText action={a} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function ConditionText({ condition: c }: { condition: RuleCondition }) {
  const op = OPERATORS[c.operator] ?? c.operator
  return (
    <span title={c.address}>
      <strong>{c.target ?? c.address}</strong> <span className="muted">{c.attribute.replace(/^state\//, '')}</span> {op}
      {c.value !== null && <> {c.value}</>}
    </span>
  )
}

function ActionText({ action: a }: { action: RuleAction }) {
  let body = a.body
  try {
    const parsed = JSON.parse(a.body) as Record<string, unknown>
    body = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(', ')
  } catch {
    /* keep raw */
  }
  return (
    <span title={`${a.method} ${a.address}`}>
      <strong>{a.target ?? a.address}</strong> → {body || a.method}
    </span>
  )
}
