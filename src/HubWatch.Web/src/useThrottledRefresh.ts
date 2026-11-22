import { useEffect, useRef, useState } from 'react'
import { useStream } from './stream'
import type { SystemEvent } from './types'

/**
 * Returns a counter that increases when live data changes (throttled), for use as an effect dependency.
 * Pass a filter to react only to relevant event types.
 */
export function useLiveRefresh(filter?: (e: SystemEvent) => boolean, delayMs = 1500) {
  const [tick, setTick] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  const schedule = () => {
    if (timer.current !== undefined) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setTick((t) => t + 1)
    }, delayMs)
  }

  useStream('events', (events) => {
    if (!filter || events.some(filter)) schedule()
  })
  useStream('snapshot', schedule)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return tick
}
