import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Alert } from '../types'
import { formatAgo, formatDuration } from '../format'
import { Bell, CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react'

interface Props {
  alerts: Alert[]
  onAcknowledge: (id: number) => void
  onAcknowledgeAll: () => void
}

export function AlertBell({ alerts, onAcknowledge, onAcknowledgeAll }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const active = alerts.filter((a) => a.resolvedAt === null)
  const unread = alerts.filter((a) => !a.acknowledged && a.resolvedAt === null).length
  const critical = active.some((a) => a.severity === 'critical')

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Narrow screens: the panel spans the top bar's width (styles.css) but starts right under the bell, not under the
  // whole bar with its tab row. Its offset within the top bar is measured, as the bar's layout varies.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const bar = root.current?.closest('.topbar')
      if (!bar || !bell.current || !panel.current) return
      const top = bell.current.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 6
      panel.current.style.setProperty('--alert-top', `${Math.round(top)}px`)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  return (
    <div className="alert-bell" ref={root}>
      <button
        ref={bell}
        className={`bell${unread ? ' has-unread' : ''}${critical ? ' critical' : ''}`}
        onClick={() => setOpen(!open)}
        aria-label={unread ? `${unread} new alerts` : 'Alerts'}
        aria-expanded={open}
      >
        <Bell aria-hidden />
        {unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>

      {open && (
        <div className="alert-panel" ref={panel} role="dialog" aria-label="Alerts">
          <div className="alert-panel-head">
            <strong>Alerts</strong>
            {unread > 0 && (
              <button className="link small" onClick={onAcknowledgeAll}>
                Mark all as read
              </button>
            )}
          </div>
          {alerts.length === 0 ? (
            <p className="muted small alert-empty">No alerts. Everything looks fine.</p>
          ) : (
            <ul className="alert-list">
              {alerts.slice(0, 30).map((a) => (
                <li
                  key={a.id}
                  className={`alert-item sev-${a.severity}${a.resolvedAt !== null ? ' resolved' : ''}${a.acknowledged ? '' : ' unread'}`}
                >
                  <span className="alert-icon" aria-hidden>
                    {a.resolvedAt !== null ? <CircleCheck /> : a.severity === 'critical' ? <OctagonAlert /> : <TriangleAlert />}
                  </span>
                  <div className="alert-text">
                    <strong>{a.title}</strong>
                    <span className="small">{a.message}</span>
                    <span className="muted tiny-inline">
                      {a.resolvedAt !== null
                        ? `Resolved ${formatAgo(a.resolvedAt)} · lasted ${formatDuration(a.resolvedAt - a.openedAt)}`
                        : `${a.severity === 'critical' ? 'Critical' : 'Warning'} · since ${formatAgo(a.openedAt)}`}
                    </span>
                  </div>
                  {!a.acknowledged && a.resolvedAt === null && (
                    <button className="link small" onClick={() => onAcknowledge(a.id)}>
                      Dismiss
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
