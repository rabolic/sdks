import type { ConsentState, Logger } from '@rabolic/sdk-core'

export const DEFAULT_HOST = 'https://ingest.rabolic.com'

export interface WebOptions {
  /** Publishable key (`rb_pub_…`). Secret keys are refused in the browser. */
  projectKey: string
  /** Ingest base URL, for first-party proxies and self-hosting. Default `https://ingest.rabolic.com`. */
  host?: string
  /** `$pageview` on SPA navigation (History API and `popstate`). Default `true`. */
  trackRoutes?: boolean
  /** `$page_leave` with active time and scroll depth. Default `true`. */
  trackPageLeave?: boolean
  /** `memory` is cookieless mode: ids live for one page lifetime. Default `localStorage`. */
  persistence?: 'localStorage' | 'memory'
  /** Domain for the `rb_aid` cookie, such as `.example.com` to share it across subdomains. */
  cookieDomain?: string
  /** Default `granted`. */
  consent?: ConsentState
  /** Log every call to the console. Default `false`. */
  debug?: boolean
  /** Flush when this many events are queued (1–500). Default 20. */
  flushAt?: number
  /** Flush at least this often, in ms (min 1000). Default 5000. */
  flushIntervalMs?: number
}

export interface ResolvedWebOptions {
  projectKey: string
  host: string
  trackRoutes: boolean
  trackPageLeave: boolean
  persistence: 'localStorage' | 'memory'
  cookieDomain: string | undefined
  consent: ConsentState
  debug: boolean
  flushAt: number
  flushIntervalMs: number
}

const PUBLISHABLE_KEY = /^rb_pub_[\w-]{1,120}$/
const HOST_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i

/**
 * Validates options at the public boundary. Returns `undefined` (after logging
 * why) when the SDK cannot start; bad optional values fall back to defaults.
 */
export function resolveOptions(input: unknown, logger: Logger): ResolvedWebOptions | undefined {
  const options = (input ?? {}) as Partial<Record<keyof WebOptions, unknown>>
  const key = options.projectKey
  if (typeof key !== 'string' || !PUBLISHABLE_KEY.test(key)) {
    logger.warn(
      /^rb_(live|test)_/.test(String(key))
        ? 'secret key refused in the browser: use the rb_pub_ key, and rotate the exposed secret key'
        : 'init needs a publishable projectKey (rb_pub_…)',
    )
    return undefined
  }
  const { cookieDomain, consent } = options
  const host = typeof options.host === 'string' && HOST_URL.test(options.host) ? options.host.replace(/\/+$/, '') : undefined
  if (options.host !== undefined && !host) logger.warn('host must be an http(s) URL')
  return {
    projectKey: key,
    host: host ?? DEFAULT_HOST,
    trackRoutes: options.trackRoutes !== false,
    trackPageLeave: options.trackPageLeave !== false,
    persistence: options.persistence === 'memory' ? 'memory' : 'localStorage',
    cookieDomain: typeof cookieDomain === 'string' && /^\.?[a-z0-9.-]+$/i.test(cookieDomain) ? cookieDomain : undefined,
    consent: consent === 'pending' || consent === 'denied' ? consent : 'granted',
    debug: options.debug === true,
    flushAt: integerInRange(options.flushAt, 1, 500, 20),
    flushIntervalMs: integerInRange(options.flushIntervalMs, 1000, 600_000, 5000),
  }
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback
}
