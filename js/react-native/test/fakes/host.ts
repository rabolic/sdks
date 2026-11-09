import type { AppStateStatus, Host } from '../../src/host'

/** A device: AsyncStorage that survives "relaunches", and an AppState the test drives. */
export class FakeDevice {
  readonly disk = new Map<string, string>()
  state: AppStateStatus = 'active'
  private listeners: Array<(state: string) => void> = []
  os: 'ios' | 'android' | 'web' = 'ios'

  host(): Host {
    return {
      storage: {
        getItem: async (key) => this.disk.get(key) ?? null,
        setItem: async (key, value) => void this.disk.set(key, value),
        removeItem: async (key) => void this.disk.delete(key),
      },
      appState: {
        currentState: this.state,
        addEventListener: (_type, listener) => {
          this.listeners.push(listener)
          return { remove: () => (this.listeners = this.listeners.filter((l) => l !== listener)) }
        },
      },
      platform: { OS: this.os, Version: this.os === 'ios' ? '18.1' : 34, isPad: false, constants: this.os === 'android' ? { Model: 'Pixel 8', Manufacturer: 'Google' } : {} },
      dimensions: { get: () => ({ width: 393, height: 852, scale: 3 }) },
    }
  }

  /** The app moves to a new AppState. */
  set(state: AppStateStatus): void {
    this.state = state
    for (const l of this.listeners) l(state)
  }
}
