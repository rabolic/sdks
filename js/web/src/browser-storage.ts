import { MemoryStore, STORAGE_KEYS, type KeyValueStore } from '@rabolic/sdk-core'

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

/** `localStorage` when it works (it throws in some private modes and sandboxed iframes), else `undefined`. */
export function localStorageStore(win: Window): KeyValueStore | undefined {
  try {
    const storage = win.localStorage
    storage.setItem('rb_probe', '1')
    storage.removeItem('rb_probe')
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    }
  } catch {
    return undefined
  }
}

export interface CookieOptions {
  domain: string | undefined
  secure: boolean
}

/** Cookies can be set by any subdomain, so only values shaped like our ids are accepted. */
export function readCookie(doc: Document, name: string): string | null {
  return new RegExp(`(?:^|;\\s*)${name}=([\\w-]{1,128})(?:;|$)`).exec(doc.cookie)?.[1] ?? null
}

/** Writes (or with `null`, deletes) a first-party cookie. Values are our ids, which need no encoding. */
export function writeCookie(doc: Document, name: string, value: string | null, options: CookieOptions): void {
  doc.cookie =
    `${name}=${value ?? ''}; Path=/; Max-Age=${value === null ? 0 : ONE_YEAR_SECONDS}; SameSite=Lax` +
    (options.domain ? `; Domain=${options.domain}` : '') +
    (options.secure ? '; Secure' : '')
}

/**
 * The web store: `localStorage` (memory if unavailable), with the anonymous id
 * mirrored to a first-party `rb_aid` cookie (protocol §4). The cookie restores
 * the id when `localStorage` was cleared, and spans subdomains with `cookieDomain`.
 */
export function createWebStore(win: Window, persistence: 'localStorage' | 'memory', cookie: CookieOptions): KeyValueStore {
  if (persistence === 'memory') return new MemoryStore()
  const primary = localStorageStore(win) ?? new MemoryStore()
  const doc = win.document
  const mirrored = STORAGE_KEYS.anonymousId
  return {
    get(key) {
      const value = primary.get(key)
      if (key !== mirrored || value !== null) return value
      return readCookie(doc, key)
    },
    set(key, value) {
      primary.set(key, value)
      if (key === mirrored) writeCookie(doc, key, value, cookie)
    },
    remove(key) {
      primary.remove(key)
      if (key === mirrored) writeCookie(doc, key, null, cookie)
    },
  }
}
