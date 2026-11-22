import { useState } from 'react'
import { Rooms } from './Rooms'
import { Devices } from './Devices'
import type { DeviceRef } from '../types'

type View = 'rooms' | 'devices'
const KEY = 'hubwatch.homeView'

function initialView(): View {
  try {
    return localStorage.getItem(KEY) === 'devices' ? 'devices' : 'rooms'
  } catch {
    return 'rooms'
  }
}

/** Your home: rooms with lights and scenes, or every device with its sensor values. */
export function Home({ onOpenDevice }: { onOpenDevice: (device: DeviceRef) => void }) {
  const [view, setView] = useState<View>(initialView)

  function choose(v: View) {
    setView(v)
    try {
      localStorage.setItem(KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <>
      <div className="page view-switch-bar">
        <div className="segmented" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'rooms'} className={view === 'rooms' ? 'active' : ''} onClick={() => choose('rooms')}>
            Rooms &amp; scenes
          </button>
          <button role="tab" aria-selected={view === 'devices'} className={view === 'devices' ? 'active' : ''} onClick={() => choose('devices')}>
            All devices
          </button>
        </div>
      </div>
      <div hidden={view !== 'rooms'}>
        <Rooms onOpenDevice={onOpenDevice} />
      </div>
      <div hidden={view !== 'devices'}>
        <Devices onOpenDevice={onOpenDevice} />
      </div>
    </>
  )
}
