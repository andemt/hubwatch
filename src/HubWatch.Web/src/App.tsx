import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { useStream } from './stream'
import type { DeviceRef, Status } from './types'
import { Setup } from './components/Setup'
import { LiveLog } from './components/LiveLog'
import { Settings } from './components/Settings'
import { Health } from './components/Health'
import { DeviceDrawer } from './components/DeviceDrawer'
import { Automations } from './components/Automations'
import { Home } from './components/Home'
import { Insights } from './components/Insights'
import { AlertBell } from './components/AlertBell'
import { useAlerts } from './useAlerts'
import { SystemsContext } from './systems'
import { loadHiddenSystems, saveHiddenSystems, setVisibleSystems } from './systemFilter'
import { SystemFilterDialog } from './components/SystemFilterDialog'
import { StatusPill } from './components/StatusPill'
import { ReconnectDialog } from './components/ReconnectDialog'
import { OfflineNotice } from './components/OfflineNotice'
import { Settings as SettingsIcon } from 'lucide-react'
import { decodeRef, encodeRef, usePanelRoute } from './panelRoute'

type Tab = 'live' | 'home' | 'insights' | 'health' | 'automations' | 'settings'

const ALL_TABS: Tab[] = ['live', 'home', 'insights', 'health', 'automations', 'settings']
const DEFAULT_TAB: Tab = 'live'

/** The tab named by the URL path (/home, /insights, …); "/" and unknown paths mean the default tab. */
function tabFromPath(path: string): Tab {
  const name = appPath(path).replace(/^\/+|\/+$/g, '').toLowerCase()
  return (ALL_TABS as string[]).includes(name) ? (name as Tab) : DEFAULT_TAB
}

function pathForTab(tab: Tab): string {
  return BASE + (tab === DEFAULT_TAB ? '/' : `/${tab}`)
}

/** The folder the app is served from, without trailing slash ("" at the root, "/hubwatch" for the hosted demo). */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '')

/** The path without the base folder. */
function appPath(path: string): string {
  return BASE && path.startsWith(BASE) ? path.slice(BASE.length) || '/' : path
}

/** The current tab, kept in the URL so a reload or a shared link opens the same view and Back/Forward move between views. */
function useTabRoute(): [Tab, (tab: Tab) => void] {
  const [tab, setTabState] = useState<Tab>(() => tabFromPath(window.location.pathname))

  useEffect(() => {
    // Normalise unknown or default paths (e.g. /foo or /live) to the canonical one without adding a history entry.
    const canonical = pathForTab(tabFromPath(window.location.pathname))
    if (window.location.pathname !== canonical) {
      window.history.replaceState(window.history.state, '', canonical + window.location.search + window.location.hash)
    }
    const onPop = () => setTabState(tabFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const setTab = useCallback((next: Tab) => {
    setTabState(next)
    const path = pathForTab(next)
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
  }, [])

  return [tab, setTab]
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'home', label: 'Home' },
  { id: 'insights', label: 'Insights' },
  { id: 'health', label: 'Health' },
  { id: 'automations', label: 'Automations' },
]

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useTabRoute()
  const [deviceParam, openDeviceRoute, closeDevice] = usePanelRoute('device')
  const openDevice = useMemo(() => decodeRef(deviceParam), [deviceParam])
  const setOpenDevice = useCallback((ref: DeviceRef) => openDeviceRoute(encodeRef(ref)), [openDeviceRoute])
  const [hidden, setHidden] = useState<string[]>(loadHiddenSystems)
  const [filterOpen, setFilterOpen] = useState(false)

  // The systems the UI shows. Hidden ones keep recording; at least one is always shown.
  const allSystems = status?.systems
  const shownSystems = useMemo(() => {
    const all = allSystems ?? []
    const shown = all.filter((s) => !hidden.includes(s.id))
    return shown.length > 0 ? shown : all
  }, [allSystems, hidden])
  const filtered = !!allSystems && shownSystems.length < allSystems.length
  // Set during render so the data requests made by this render's effects already use it.
  setVisibleSystems(filtered ? shownSystems.map((s) => s.id) : null)

  function chooseHidden(ids: string[]) {
    const valid = ids.filter((id) => allSystems?.some((s) => s.id === id))
    saveHiddenSystems(valid)
    setHidden(valid)
  }

  // Identifies the shown systems; data views are remounted when it changes so they load everything
  // afresh (a removed or hidden system's data disappears, a new or shown one's appears).
  const systemsKey = status ? shownSystems.map((s) => s.id).join(',') : null
  const hasSystems = !!status && status.systems.length > 0
  const { alerts, acknowledge, acknowledgeAll } = useAlerts(systemsKey)
  const topbar = useRef<HTMLElement>(null)
  const activeAlerts = alerts.filter((a) => a.resolvedAt === null).length

  // Sticky elements below the top bar need its real height, which changes when the tabs wrap.
  useEffect(() => {
    const el = topbar.current
    if (!el) return
    const observer = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--topbar-height', `${el.offsetHeight}px`),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasSystems])

  // On narrow screens the tabs scroll sideways; keep the active one fully visible (only the tab row scrolls, not the page).
  useEffect(() => {
    const nav = topbar.current?.querySelector<HTMLElement>('.tabs')
    const active = nav?.querySelector<HTMLElement>('button.active')
    if (!nav || !active) return
    const left = active.offsetLeft - nav.offsetLeft
    const right = left + active.offsetWidth
    if (left < nav.scrollLeft) nav.scrollLeft = left
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth
  }, [tab, hasSystems])

  useEffect(() => {
    api.status().then(setStatus).catch((e: Error) => setError(e.message))
  }, [])

  useStream('status', setStatus)

  // Close the device panel when the shown systems change (its device may be gone), but not on the first load:
  // then the panel comes from the URL.
  const previousSystemsKey = useRef(systemsKey)
  useEffect(() => {
    const previous = previousSystemsKey.current
    previousSystemsKey.current = systemsKey
    if (previous !== null && previous !== systemsKey) closeDevice()
  }, [systemsKey, closeDevice])

  if (!status) {
    return (
      <div className="center">
        {error ? <p>Cannot reach the HubWatch server: {error}</p> : <p className="muted">Loading…</p>}
      </div>
    )
  }

  if (!hasSystems) {
    return <Setup onPaired={() => api.status().then(setStatus)} />
  }

  return (
    <SystemsContext.Provider value={shownSystems}>
      <div className="app">
        <header className="topbar" ref={topbar}>
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={22} height={22} />
            <span className="brand-text">HubWatch</span>
          </div>
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'health' && activeAlerts > 0 && (
                  <span className="tab-badge" aria-label={`${activeAlerts} active problems`}>
                    {activeAlerts}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <AlertBell alerts={alerts} onAcknowledge={acknowledge} onAcknowledgeAll={acknowledgeAll} />
          <button
            className={`icon-button${tab === 'settings' ? ' active' : ''}`}
            onClick={() => setTab(tab === 'settings' ? DEFAULT_TAB : 'settings')}
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon aria-hidden />
          </button>
          <StatusPill
            status={status}
            shownCount={shownSystems.length}
            onClick={
              status.systems.length > 1 || status.systems[0]?.state === 'offline' ? () => setFilterOpen(true) : undefined
            }
            clickHint={status.systems.length > 1 ? 'Click to choose which systems to show' : 'Click to try again'}
          />
        </header>

        {/* Views stay mounted so the live log keeps collecting while you look elsewhere. */}
        <main>
          {(tab === 'home' || tab === 'health' || tab === 'automations') && <OfflineNotice systems={shownSystems} />}
          <Fragment key={systemsKey ?? ''}>
            <section hidden={tab !== 'live'}>
              <LiveLog />
            </section>
            <section hidden={tab !== 'home'}>
              <Home onOpenDevice={setOpenDevice} />
            </section>
            <section hidden={tab !== 'insights'}>
              <Insights onOpenDevice={setOpenDevice} />
            </section>
            <section hidden={tab !== 'health'}>
              <Health onOpenDevice={setOpenDevice} />
            </section>
            <section hidden={tab !== 'automations'}>
              <Automations />
            </section>
          </Fragment>
          <section hidden={tab !== 'settings'}>
            <Settings status={status} />
          </section>
        </main>

        {openDevice && (
          <DeviceDrawer key={`${openDevice.systemId}-${openDevice.id}`} device={openDevice} onClose={closeDevice} />
        )}

        <SystemFilterDialog
          open={filterOpen && status.systems.length > 1}
          systems={status.systems}
          hidden={hidden.filter((id) => status.systems.some((s) => s.id === id))}
          onChange={chooseHidden}
          onClose={() => setFilterOpen(false)}
        />
        {status.systems.length === 1 && (
          <ReconnectDialog
            open={filterOpen}
            system={status.systems[0]}
            onClose={() => setFilterOpen(false)}
          />
        )}
      </div>
    </SystemsContext.Provider>
  )
}
