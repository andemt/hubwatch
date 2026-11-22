import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStream } from '../stream'
import type { SystemEvent, Session } from '../types'
import { gapsFrom } from '../sessions'
import { useSystemName } from '../systems'
import {
  CATEGORIES,
  type Category,
  categoryOf,
  isGroup,
  formatDay,
  formatDuration,
  formatShortTime,
  formatTime,
} from '../format'
import { Pause, Play } from 'lucide-react'
import { CategoryIcon } from '../icons'
import { EventDrawer } from './EventDrawer'
import { usePanelRoute } from '../panelRoute'

const PAGE_SIZE = 200
const MAX_IN_MEMORY = 5000

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'gap'; key: string; systemId: string; start: number; end: number }
  | { kind: 'event'; key: string; event: SystemEvent }

/** Combines two lists, removes duplicates and sorts newest first. */
function merge(a: SystemEvent[], b: SystemEvent[], cap = Infinity): SystemEvent[] {
  const byId = new Map<number, SystemEvent>()
  for (const e of a) byId.set(e.id, e)
  for (const e of b) byId.set(e.id, e)
  return [...byId.values()].sort((x, y) => y.ts - x.ts || y.id - x.id).slice(0, cap)
}

export function LiveLog() {
  const [events, setEvents] = useState<SystemEvent[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const systemName = useSystemName()
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [showGroups, setShowGroups] = useState(false)
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)
  const [eventParam, openEvent, closeEvent] = usePanelRoute('event')
  const selectedId = eventParam !== null && /^\d+$/.test(eventParam) ? Number(eventParam) : null
  // An event linked to (or older than what is loaded) is fetched on its own.
  const [fetched, setFetched] = useState<SystemEvent | null>(null)
  const inList = selectedId !== null && events.some((e) => e.id === selectedId)
  const selected = selectedId === null ? null : (events.find((e) => e.id === selectedId) ?? (fetched?.id === selectedId ? fetched : null))
  const pending = useRef<SystemEvent[]>([])
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    Promise.all([api.events({ limit: PAGE_SIZE }), api.sessions()])
      .then(([initial, s]) => {
        setEvents(initial)
        setSessions(s)
        setHasMore(initial.length === PAGE_SIZE)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (eventParam !== null && selectedId === null) {
      closeEvent() // not an event id
      return
    }
    if (selectedId === null || loading || inList || fetched?.id === selectedId) return
    let cancelled = false
    api
      .event(selectedId)
      .then((e) => !cancelled && setFetched(e))
      .catch(() => !cancelled && closeEvent()) // gone, or its system is hidden
    return () => {
      cancelled = true
    }
  }, [eventParam, selectedId, loading, inList, fetched, closeEvent])

  useStream('events', (incoming) => {
    if (paused) {
      pending.current = merge(pending.current, incoming)
      setPendingCount(pending.current.length)
    } else {
      setEvents((prev) => merge(prev, incoming, MAX_IN_MEMORY))
    }
  })

  // After a (re)connect the server may have recorded events from while we were away.
  useStream('snapshot', () => {
    api.events({ limit: PAGE_SIZE }).then((latest) => setEvents((prev) => merge(prev, latest, MAX_IN_MEMORY)))
    api.sessions().then(setSessions)
  })

  function resume() {
    setEvents((prev) => merge(prev, pending.current, MAX_IN_MEMORY))
    pending.current = []
    setPendingCount(0)
    setPaused(false)
  }

  async function loadOlder() {
    const last = events[events.length - 1]
    if (!last) return
    const older = await api.events({ beforeTs: last.ts, beforeId: last.id, limit: PAGE_SIZE })
    setEvents((prev) => merge(prev, older))
    setHasMore(older.length === PAGE_SIZE)
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter((e) => {
      if (!showGroups && isGroup(e.resourceType)) return false
      if (category !== 'all' && categoryOf(e.resourceType) !== category) return false
      if (!q) return true
      return [e.name, e.room, e.summary].some((v) => v?.toLowerCase().includes(q))
    })
  }, [events, category, search, showGroups])

  const counts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {}
    for (const e of events) {
      if (!showGroups && isGroup(e.resourceType)) continue
      const cat = categoryOf(e.resourceType)
      c[cat] = (c[cat] ?? 0) + 1
    }
    return c
  }, [events, showGroups])

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    const oldest = events[events.length - 1]?.ts ?? Date.now()
    const gaps = gapsFrom(sessions).filter((g) => g.end >= oldest)
    let gapIndex = 0
    let lastDay = ''

    const pushDay = (ts: number) => {
      const label = formatDay(ts)
      if (label !== lastDay) {
        lastDay = label
        result.push({ kind: 'day', key: `day-${ts}`, label })
      }
    }

    for (const event of visible) {
      while (gapIndex < gaps.length && gaps[gapIndex].end > event.ts) {
        const gap = gaps[gapIndex++]
        pushDay(gap.end)
        result.push({ kind: 'gap', key: `gap-${gap.systemId}-${gap.start}`, ...gap })
      }
      pushDay(event.ts)
      result.push({ kind: 'event', key: `ev-${event.id}`, event })
    }
    return result
  }, [visible, sessions, events])

  return (
    <div className="page">
      <div className="toolbar">
        <div className="chips">
          <button className={category === 'all' ? 'chip active' : 'chip'} onClick={() => setCategory('all')}>
            All
          </button>
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <button key={c} className={category === c ? 'chip active' : 'chip'} onClick={() => setCategory(c)}>
              <CategoryIcon category={c} /> {CATEGORIES[c].label}
              {counts[c] ? <span className="count">{counts[c]}</span> : null}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <label className="check">
            <input type="checkbox" checked={showGroups} onChange={(e) => setShowGroups(e.target.checked)} />
            Rooms &amp; zones
          </label>
          <input
            className="search"
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="secondary with-icon" onClick={() => (paused ? resume() : setPaused(true))}>
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {paused && pendingCount > 0 && (
        <button className="banner" onClick={resume}>
          {pendingCount} new event{pendingCount === 1 ? '' : 's'} – click to show
        </button>
      )}

      {loading ? (
        <p className="muted center-text">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No events yet.</p>
          <p className="muted">Turn on a light or walk past a motion sensor – it shows up here instantly.</p>
        </div>
      ) : (
        <ul className="log">
          {rows.map((row) => {
            if (row.kind === 'day') {
              return (
                <li key={row.key} className="day">
                  {row.label}
                </li>
              )
            }
            if (row.kind === 'gap') {
              return (
                <li key={row.key} className="gap">
                  Not recording{systemName(row.systemId) ? ` from ${systemName(row.systemId)}` : ''}{' '}
                  {formatShortTime(row.start)} – {formatShortTime(row.end)} · {formatDuration(row.end - row.start)} (app
                  was closed or the {systemName(row.systemId) ? 'system' : 'bridge'} was unreachable)
                </li>
              )
            }
            const e = row.event
            const cat = categoryOf(e.resourceType)
            const isOpen = selectedId === e.id
            return (
              <li key={row.key}>
                <button
                  type="button"
                  className={`event cat-${cat}${isOpen ? ' open' : ''}`}
                  aria-haspopup="dialog"
                  onClick={() => openEvent(String(e.id))}
                >
                  <span className="time">{formatTime(e.ts)}</span>
                  <span className="icon"><CategoryIcon category={cat} /></span>
                  <span className="who">
                    <strong>{e.name ?? e.resourceType.replace(/_/g, ' ')}</strong>
                    {e.room && e.room !== e.name && <span className="room">{e.room}</span>}
                    {systemName(e.systemId) && <span className="room">{systemName(e.systemId)}</span>}
                  </span>
                  <span className="what">
                    {e.summary}
                    {e.eventType === 'backfill' && (
                      <span className="badge" title="Happened while the app was not running. Time reported by the bridge.">
                        while closed
                      </span>
                    )}
                    {e.origin === 'hubwatch' && (
                      <span className="badge origin" title="Switched from HubWatch">
                        from HubWatch
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {hasMore && !loading && (
        <div className="center-text">
          <button className="secondary" onClick={loadOlder}>
            Load older events
          </button>
        </div>
      )}

      {selected && <EventDrawer key={selected.id} event={selected} onClose={closeEvent} />}
    </div>
  )
}
