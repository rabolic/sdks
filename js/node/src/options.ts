export const DEFAULT_HOST = 'https://ingest.rabolic.com'

export interface RabolicOptions {
  /**
   * Secret key (`rb_live_…` or `rb_test_…`). Typed to accept
   * `process.env.RABOLIC_SECRET_KEY` directly; a missing key throws.
   */
  secretKey: string | undefined
  /** Ingest base URL, for proxies and self-hosting. Default `https://ingest.rabolic.com`. */
  host?: string
  /** Flush when this many events are queued (1–500). Default 20. */
  flushAt?: number
  /** Flush at least this often, in ms. Default 10000. */
  flushIntervalMs?: number
  /** Most events kept in memory; the oldest are dropped beyond it. Default 10000. */
  maxQueueSize?: number
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number
  /** Log every call to the console. Default `false`. */
  debug?: boolean
}

export interface ResolvedOptions {
  secretKey: string
  host: string
  flushAt: number
  flushIntervalMs: number
  maxQueueSize: number
  timeoutMs: number
  debug: boolean
}

/**
 * Configuration errors throw, once, at construction: unlike tracking calls,
 * a wrong key or host is a deployment bug that must not pass silently.
 * Messages never include the key itself.
 */
export function resolveOptions(options: RabolicOptions): ResolvedOptions {
  const key = options?.secretKey
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[rabolic] secretKey is required (rb_live_… or rb_test_…). Is RABOLIC_SECRET_KEY set?')
  }
  if (key.startsWith('rb_pub_')) {
    throw new TypeError(
      '[rabolic] @rabolic/node needs a secret key (rb_live_… or rb_test_…), not a publishable key (rb_pub_…). Publishable keys are for browsers and apps.',
    )
  }
  if (!/^rb_(live|test)_[\w-]{1,120}$/.test(key)) {
    throw new TypeError('[rabolic] secretKey must start with rb_live_ or rb_test_')
  }
  const host = options.host ?? DEFAULT_HOST
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(host)) throw new TypeError('[rabolic] host must be an http(s) URL')
  return {
    secretKey: key,
    host: host.replace(/\/+$/, ''),
    flushAt: integerInRange(options.flushAt, 1, 500, 20),
    flushIntervalMs: integerInRange(options.flushIntervalMs, 100, 3_600_000, 10_000),
    maxQueueSize: integerInRange(options.maxQueueSize, 1, 1_000_000, 10_000),
    timeoutMs: integerInRange(options.timeoutMs, 100, 120_000, 10_000),
    debug: options.debug === true,
  }
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback
}
