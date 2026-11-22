import type { Session } from './types'

export interface Gap {
  systemId: string
  start: number
  end: number
}

/**
 * Periods between a system's connected sessions, when nothing was recorded from it.
 * Each system has its own gaps: one system recording says nothing about another.
 * With rangeStart, the time from rangeStart until a system's first session is a gap too
 * (pass sessions queried from that same start).
 * Pass systemIds to include systems without any session in the range (their whole range is a gap).
 */
export function gapsFrom(sessions: Session[], rangeStart?: number, minMs = 60_000, systemIds?: string[]): Gap[] {
  const bySystem = new Map<string, Session[]>()
  for (const id of systemIds ?? []) bySystem.set(id, [])
  for (const s of sessions) {
    const list = bySystem.get(s.systemId)
    if (list) list.push(s)
    else bySystem.set(s.systemId, [s])
  }
  const gaps = [...bySystem].flatMap(([systemId, list]) => systemGaps(systemId, list, rangeStart, minMs))
  return gaps.sort((a, b) => b.end - a.end)
}

function systemGaps(systemId: string, sessions: Session[], rangeStart: number | undefined, minMs: number): Gap[] {
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
  const gaps: Gap[] = []
  if (rangeStart !== undefined) {
    const firstStart = sorted[0]?.startedAt ?? Date.now()
    if (firstStart - rangeStart > minMs) gaps.push({ systemId, start: rangeStart, end: firstStart })
  }
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1].endedAt ?? sorted[i - 1].lastSeenAt
    const end = sorted[i].startedAt
    if (end - start > minMs) gaps.push({ systemId, start, end })
  }
  return gaps
}
