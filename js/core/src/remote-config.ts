import { fnv1a32 } from './ids'
import type { Logger } from './logger'
import type { Clock, Timers } from './platform'
import { readJson, writeJson, type KeyValueStore } from './storage'
import { sendWithTimeout, type Transport } from './transport'

/** `GET /v1/config` (protocol §6). */
export interface RemoteConfig {
  enabled: boolean
  sessionTimeoutWebMin: number
  sessionBackgroundSec: number
  autocapture: { pageviews: boolean; pageLeave: boolean; lifecycle: boolean; screens: boolean }
  blockedEvents: string[]
  sampleRate: number
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  enabled: true,
  sessionTimeoutWebMin: 30,
  sessionBackgroundSec: 30,
  autocapture: { pageviews: true, pageLeave: true, lifecycle: true, screens: false },
  blockedEvents: [],
  sampleRate: 1,
}

export const CONFIG_CACHE_TTL_MS: number = 5 * 60 * 1000

interface CachedConfig {
  fetchedAt: number
  config: RemoteConfig
}

export type ConfigFetchResult = { status: 'ok'; config: RemoteConfig } | { status: 'unauthorized' } | { status: 'failed' }

export interface RemoteConfigOptions {
  host: string
  key: string
  transport: Transport
  store: KeyValueStore
  storageKey: string
  clock: Clock
  timers: Timers
  logger: Logger
  timeoutMs: number
}

/**
 * Holds the current remote config: the cached copy (or defaults) right away,
 * replaced by the fetched copy when it arrives. Tracking never waits for it.
 */
export interface RemoteConfigLoader {
  readonly config: RemoteConfig
  /** Fetches unless the cached copy is younger than 5 minutes. */
  refresh(): Promise<ConfigFetchResult>
}

export function createRemoteConfigLoader(options: RemoteConfigOptions): RemoteConfigLoader {
  const { clock, store, storageKey, logger } = options
  const cached = readJson(store, storageKey) as Partial<CachedConfig> | null | undefined
  const cacheIsFresh = typeof cached?.fetchedAt === 'number' && clock.now() - cached.fetchedAt < CONFIG_CACHE_TTL_MS
  let current = parseRemoteConfig(cached?.config)

  return {
    get config() {
      return current
    },
    async refresh() {
      if (cacheIsFresh) return { status: 'ok', config: current }
      try {
        const response = await sendWithTimeout(
          options.transport,
          { method: 'GET', url: `${options.host}/v1/config?key=${encodeURIComponent(options.key)}`, headers: {} },
          options.timeoutMs,
          options.timers,
        )
        if (response.status === 401) return { status: 'unauthorized' }
        if (response.status !== 200) {
          logger.debug(`config ${response.status}`)
          return { status: 'failed' }
        }
        current = parseRemoteConfig(JSON.parse(response.body))
        writeJson(store, storageKey, { fetchedAt: clock.now(), config: current })
        return { status: 'ok', config: current }
      } catch (error) {
        logger.debug('config failed', error)
        return { status: 'failed' }
      }
    },
  }
}

/** Reads a config defensively: missing, mistyped or out-of-range fields fall back to the defaults. */
export function parseRemoteConfig(input: unknown): RemoteConfig {
  const config = overlay(DEFAULT_REMOTE_CONFIG, input)
  const defaults = DEFAULT_REMOTE_CONFIG
  config.blockedEvents = config.blockedEvents.filter((name) => typeof name === 'string')
  if (!(config.sampleRate >= 0 && config.sampleRate <= 1)) config.sampleRate = defaults.sampleRate
  if (!(config.sessionTimeoutWebMin > 0)) config.sessionTimeoutWebMin = defaults.sessionTimeoutWebMin
  if (!(config.sessionBackgroundSec > 0)) config.sessionBackgroundSec = defaults.sessionBackgroundSec
  return config
}

/** A copy of `defaults` with each field taken from `input` when it has the same JSON type. */
function overlay<T extends object>(defaults: T, input: unknown): T {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const result = { ...defaults }
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const fallback = defaults[key]
    const value = source[key]
    if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)) {
      result[key] = overlay(fallback, value) as T[keyof T & string]
    } else if (typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback)) {
      result[key] = value as T[keyof T & string]
    }
  }
  return result
}

/** Protocol §6: keep the device when `hash(anonymous_id) / 2^32 < sampleRate`. Stable per id. */
export function isSampledIn(anonymousId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true
  return fnv1a32(anonymousId) / 2 ** 32 < sampleRate
}
