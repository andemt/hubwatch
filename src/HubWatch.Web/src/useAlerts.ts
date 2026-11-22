import { useEffect, useState } from 'react'
import { api } from './api'
import { useStream } from './stream'
import type { Alert } from './types'
import { browserNotifications } from './notifications'

/**
 * All alerts of the connected systems, kept live. New alerts also show a browser notification when enabled.
 * Pass something that identifies the set of systems so the list is reloaded when it changes.
 */
export function useAlerts(systemsKey?: string | null) {
  const [alerts, setAlerts] = useState<Alert[]>([])

  useEffect(() => {
    let stale = false
    setAlerts([])
    api
      .alerts()
      .then((list) => {
        if (!stale) setAlerts(list)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [systemsKey])

  useStream('alert', (alert) => {
    setAlerts((prev) => {
      const isNew = !prev.some((a) => a.id === alert.id)
      if (isNew && alert.resolvedAt === null) browserNotifications.show(alert.title, alert.message)
      return [alert, ...prev.filter((a) => a.id !== alert.id)]
    })
  })

  const acknowledge = (id: number) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)))
    api.ackAlert(id).catch(() => {})
  }

  const acknowledgeAll = () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, acknowledged: true })))
    api.ackAllAlerts().catch(() => {})
  }

  return { alerts, acknowledge, acknowledgeAll }
}
