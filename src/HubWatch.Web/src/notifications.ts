const KEY = 'hubwatch.browserNotifications'

export const browserNotifications = {
  supported: () => typeof window !== 'undefined' && 'Notification' in window,

  enabled(): boolean {
    try {
      return this.supported() && localStorage.getItem(KEY) === 'on' && Notification.permission === 'granted'
    } catch {
      return false
    }
  },

  async enable(): Promise<boolean> {
    if (!this.supported()) return false
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    const ok = permission === 'granted'
    try {
      localStorage.setItem(KEY, ok ? 'on' : 'off')
    } catch {
      /* storage unavailable */
    }
    return ok
  },

  disable() {
    try {
      localStorage.setItem(KEY, 'off')
    } catch {
      /* storage unavailable */
    }
  },

  show(title: string, body: string) {
    if (!this.enabled()) return
    try {
      new Notification(title, { body, icon: `${import.meta.env.BASE_URL}favicon.svg` })
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  },
}
