/**
 * Synchronous key-value storage, as `localStorage` offers. Runtimes with only
 * async storage (React Native's AsyncStorage) hydrate an in-memory copy at
 * startup and write through in the background, then expose it through this.
 */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export class MemoryStore implements KeyValueStore {
  readonly #values = new Map<string, string>()

  get(key: string): string | null {
    return this.#values.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.#values.set(key, value)
  }

  remove(key: string): void {
    this.#values.delete(key)
  }
}

/** Wraps a store so quota errors, disabled storage and similar never escape. */
export function safeStore(store: KeyValueStore, onError: (error: unknown) => void = () => {}): KeyValueStore {
  return {
    get(key) {
      try {
        return store.get(key)
      } catch (error) {
        onError(error)
        return null
      }
    },
    set(key, value) {
      try {
        store.set(key, value)
      } catch (error) {
        onError(error)
      }
    },
    remove(key) {
      try {
        store.remove(key)
      } catch (error) {
        onError(error)
      }
    },
  }
}

/**
 * Applies consent to storage (protocol §7). While consent is not granted,
 * writes stay in memory; existing values can still be read. `persist()`
 * commits the buffered writes; `wipe` removes keys from both layers.
 */
export interface ConsentGatedStore extends KeyValueStore {
  /** Starts persisting, writing out everything buffered so far. */
  persist(): void
  /** Keeps further writes in memory only. */
  buffer(): void
  /** Forgets `keys` in memory and in persistent storage. */
  wipe(keys: readonly string[]): void
}

export function createConsentGatedStore(persistent: KeyValueStore, persisting: boolean): ConsentGatedStore {
  /** Buffered writes; `null` marks a removal. */
  const buffered = new Map<string, string | null>()
  const write = (key: string, value: string | null): void => {
    if (!persisting) buffered.set(key, value)
    else if (value === null) persistent.remove(key)
    else persistent.set(key, value)
  }
  return {
    get: (key) => (buffered.has(key) ? (buffered.get(key) ?? null) : persistent.get(key)),
    set: write,
    remove: (key) => write(key, null),
    persist() {
      persisting = true
      buffered.forEach((value, key) => write(key, value))
      buffered.clear()
    },
    buffer() {
      persisting = false
    },
    wipe(keys) {
      for (const key of keys) {
        buffered.delete(key)
        persistent.remove(key)
      }
    },
  }
}

export function readJson(store: KeyValueStore, key: string): unknown {
  const raw = store.get(key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  store.set(key, JSON.stringify(value))
}
