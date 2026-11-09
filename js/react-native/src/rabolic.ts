/**
 * Rabolic for React Native (iOS and Android, Expo included). The engine is
 * the shared core, as on the web; this file adds what an app has: storage
 * through AsyncStorage, the app lifecycle through AppState (protocol §3–§4),
 * screens, and deep links.
 */
import {
  createDeviceClient,
  createLogger,
  fetchTransport,
  mathRandomFraction,
  STORAGE_KEYS,
  systemClock,
  systemTimers,
  type Clock,
  type ConsentState,
  type DeviceClient,
  type Properties,
  type RandomBytes,
  type RandomFraction,
  type Timers,
  type Transport,
} from '@rabolic/sdk-core'
import { deviceContext, type AppInfo } from './context'
import { reactNativeHost, type Host } from './host'
import { hydrateStore, type HydratedStore } from './storage'
import { VERSION } from './version'

export const DEFAULT_HOST = 'https://ingest.rabolic.com'
const PUBLISHABLE_KEY = /^rb_pub_[\w-]{1,120}$/
const HOST_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i
/** Calls made before `init` finishes are kept and replayed, up to this many. */
const MAX_EARLY_CALLS = 1000
/** Mobile sessions end in the background, never by inactivity in the foreground. */
const NO_INACTIVITY_TIMEOUT = Number.MAX_SAFE_INTEGER
const INSTALLED_KEY = 'rb_installed'
const APP_VERSION_KEY = 'rb_app_version'

export interface ReactNativeOptions {
  /** The project's publishable key (`rb_pub_…`). */
  projectKey: string
  /** Ingest base URL, for a first-party proxy. Default `https://ingest.rabolic.com`. */
  host?: string
  /** Your app's version and build. With a version, the first launch on a new one sends `$app_update`. */
  app?: AppInfo
  /** `$app_first_open`, `$app_update`, `$app_open` and `$app_background`. Default true. */
  trackLifecycle?: boolean
  /** Starting consent when the app hasn't set it before. Default `granted`. */
  consent?: ConsentState
  /** Send when this many events are queued (1–500). Default 20. */
  flushAt?: number
  /** Send queued events at least this often. Default 15,000 ms. */
  flushIntervalMs?: number
  /** Events kept on the device; the oldest go first. Default 10,000. */
  maxQueueSize?: number
  /** Log calls and responses. */
  debug?: boolean
}

/** A React Navigation container ref (also what Expo Router's useNavigationContainerRef() returns). */
export interface NavigationRefLike {
  addListener(event: 'state', callback: () => void): () => void
  getCurrentRoute(): { name: string } | undefined
  isReady?(): boolean
}

export interface RabolicReactNative {
  /** Starts the SDK. Calls made before it finishes are kept and sent after the launch events. */
  init(options: ReactNativeOptions): Promise<void>
  /** A custom event. Names are snake_case and may not start with `$`. */
  track(event: string, properties?: Properties): void
  /** A `$screen` view. */
  screen(name: string, properties?: Properties): void
  /** Sets `user_id` on this and every later event, and links this install to the user. */
  identify(userId: string, traits?: Properties): void
  /** Logout: new anonymous id and session, no user id, no super properties. */
  reset(): void
  register(properties: Properties): void
  unregister(key: string): void
  setConsent(state: ConsentState): void
  optOut(): void
  optIn(): void
  /** Sends queued events now. Never rejects. */
  flush(): Promise<void>
  /** This install's anonymous id, or `null` until `init` finishes. */
  getAnonymousId(): string | null
  /** `$deep_link` for a link the app was opened with. An `rb_aid` parameter (from the web SDK's appLink) is reported as `linked_anonymous_id`. */
  trackDeepLink(url: string): void
  /** Sends `$screen` for every route change of a React Navigation container. Returns the unsubscribe function. */
  trackNavigation(ref: NavigationRefLike): () => void
}

/** Test seams. Everything defaults to React Native itself. */
export interface ReactNativeEnvironment {
  host?: Host
  transport?: Transport
  clock?: Clock
  timers?: Timers
  random?: RandomFraction
  randomBytes?: RandomBytes
}

export function createRabolic(environment: ReactNativeEnvironment = {}): RabolicReactNative {
  let client: DeviceClient | undefined
  let starting: Promise<void> | undefined
  let store: HydratedStore | undefined
  let debug = false
  let lifecycle = true
  const early: Array<() => void> = []
  const logger = createLogger(() => debug)
  const clock = environment.clock ?? systemClock

  let foregroundSince: number | undefined
  let backgroundSince: number | undefined
  let launchOpenPending = false

  function guarded<A extends unknown[]>(action: (sdk: DeviceClient, ...args: A) => void): (...args: A) => void {
    const method = (...args: A): void => {
      try {
        if (client) action(client, ...args)
        else if (early.length < MAX_EARLY_CALLS) early.push(() => method(...args))
      } catch (error) {
        logger.debug('call failed', error)
      }
    }
    return method
  }

  const lifecycleOn = (sdk: DeviceClient) => lifecycle && sdk.remoteConfig.autocapture.lifecycle
  const lifecycleEvent = (sdk: DeviceClient, event: string, properties: Properties = {}) => {
    if (lifecycleOn(sdk)) sdk.capture({ type: 'track', event, properties, reserved: true })
  }

  /** `launch`: the app was opened, not brought back from the background. */
  function onForeground(sdk: DeviceClient, now: number, launch = false): void {
    if (foregroundSince !== undefined) return
    const away = backgroundSince
    backgroundSince = undefined
    foregroundSince = now
    if (away !== undefined && now - away > sdk.remoteConfig.sessionBackgroundSec * 1000) sdk.session.start(now)
    lifecycleEvent(sdk, '$app_open', { from_background: !launch && !launchOpenPending })
    launchOpenPending = false
  }

  function onBackground(sdk: DeviceClient, now: number): void {
    if (foregroundSince === undefined) return
    lifecycleEvent(sdk, '$app_background', { foreground_ms: Math.max(0, now - foregroundSince) })
    foregroundSince = undefined
    backgroundSince = now
    void sdk.flush().then(() => store?.settled())
  }

  async function start(input: ReactNativeOptions): Promise<void> {
    const options = resolveOptions(input, logger)
    if (!options) return
    debug = options.debug
    lifecycle = options.trackLifecycle
    const host = environment.host ?? reactNativeHost()
    const os = host.platform.OS
    if (os !== 'ios' && os !== 'android') return logger.warn(`platform ${os} isn't supported; use @rabolic/web on the web`)

    const launch = clock.now()
    store = await hydrateStore(host.storage, [...Object.values(STORAGE_KEYS), INSTALLED_KEY, APP_VERSION_KEY], logger)
    const fixed = deviceContext(host.platform, host.dimensions, options.app)
    const sdk = createDeviceClient({
      key: options.projectKey,
      host: options.host,
      library: { name: 'rabolic-react-native', version: VERSION },
      platform: os,
      store,
      transport: environment.transport ?? fetchTransport(),
      logger,
      consent: options.consent,
      flushAt: options.flushAt,
      flushIntervalMs: options.flushIntervalMs,
      maxQueueSize: options.maxQueueSize,
      sessionTimeoutMs: () => NO_INACTIVITY_TIMEOUT,
      getContext: () => fixed,
      keyPlacement: 'header',
      clock,
      timers: environment.timers ?? systemTimers,
      random: environment.random ?? mathRandomFraction,
      randomBytes: environment.randomBytes ?? secureOrFallbackRandom(logger),
    })
    client = sdk
    // A launch is a new session (protocol §4).
    sdk.session.start(launch)
    sdk.start()

    // $app_first_open or $app_update, then $app_open, before anything called while loading.
    const installed = store.get(INSTALLED_KEY) !== null
    const previous = store.get(APP_VERSION_KEY)
    const version = options.app?.version
    if (!installed) lifecycleEvent(sdk, '$app_first_open')
    else if (version && previous && version !== previous) lifecycleEvent(sdk, '$app_update', { previous_version: previous })
    store.set(INSTALLED_KEY, '1')
    if (version) store.set(APP_VERSION_KEY, version)

    // A launch straight into the background (a push, a background fetch) isn't an open until the app is shown.
    if (host.appState.currentState === 'active' || host.appState.currentState == null) onForeground(sdk, launch, true)
    else {
      launchOpenPending = true
      backgroundSince = launch
    }
    host.appState.addEventListener('change', (state) => {
      try {
        if (state === 'active') onForeground(sdk, clock.now())
        // iOS passes through 'inactive' (control center, calls); only 'background' counts.
        else if (state === 'background') onBackground(sdk, clock.now())
      } catch (error) {
        logger.debug('lifecycle failed', error)
      }
    })
    logger.debug('initialized', options.host)
  }

  const setConsent = guarded((sdk, state: ConsentState) => sdk.setConsent(state))
  const screen = guarded((sdk, name: string, properties?: Properties) => {
    if (typeof name !== 'string' || !name.trim()) return logger.warn('screen needs a name')
    const screenName = name.trim().slice(0, 255)
    sdk.capture({ type: 'screen', event: '$screen', reserved: true, properties: { ...properties, name: screenName }, context: { screen_name: screenName } })
  })

  return {
    init(input) {
      if (!starting) {
        starting = start(input)
          .catch((error: unknown) => logger.warn('init failed', error))
          .then(() => {
            if (client) for (const call of early.splice(0)) call()
            else early.length = 0
          })
      }
      return starting
    },
    track: guarded((sdk, event: string, properties?: Properties) => sdk.capture({ type: 'track', event, properties })),
    screen,
    identify: guarded((sdk, userId: string, traits?: Properties) => sdk.identify(userId, traits)),
    reset: guarded((sdk) => sdk.reset()),
    register: guarded((sdk, properties: Properties) => sdk.register(properties)),
    unregister: guarded((sdk, key: string) => sdk.unregister(key)),
    setConsent,
    optOut: () => setConsent('denied'),
    optIn: () => setConsent('granted'),
    flush: () => (client ? client.flush().then(() => store?.settled()) : Promise.resolve()),
    getAnonymousId: () => (client ? client.anonymousId : null),
    trackDeepLink: guarded((sdk, url: string) => {
      if (typeof url !== 'string' || !url) return
      const linked = /[?&]rb_aid=([^&#]+)/.exec(url)?.[1]
      const properties: Properties = { url: url.slice(0, 2000) }
      if (linked) properties.linked_anonymous_id = safeDecode(linked).slice(0, 128)
      sdk.capture({ type: 'track', event: '$deep_link', reserved: true, properties })
    }),
    trackNavigation(ref) {
      let last: string | undefined
      const report = () => {
        try {
          const route = ref.getCurrentRoute()
          if (route?.name && route.name !== last) {
            last = route.name
            screen(route.name)
          }
        } catch (error) {
          logger.debug('navigation failed', error)
        }
      }
      if (ref.isReady?.() !== false) report()
      const unsubscribe = ref.addListener('state', report)
      return () => unsubscribe?.()
    },
  }
}

interface ResolvedOptions {
  projectKey: string
  host: string
  app: AppInfo | undefined
  trackLifecycle: boolean
  consent: ConsentState
  flushAt: number
  flushIntervalMs: number
  maxQueueSize: number
  debug: boolean
}

export function resolveOptions(input: unknown, logger: { warn(...args: unknown[]): void }): ResolvedOptions | undefined {
  const o = (input ?? {}) as Partial<Record<keyof ReactNativeOptions, unknown>>
  const key = o.projectKey
  if (typeof key !== 'string' || !PUBLISHABLE_KEY.test(key)) {
    logger.warn(/^rb_(live|test)_/.test(String(key)) ? 'secret key refused in an app: use the rb_pub_ key, and rotate the exposed secret key' : 'init needs a publishable projectKey (rb_pub_…)')
    return undefined
  }
  const host = typeof o.host === 'string' && HOST_URL.test(o.host) ? o.host.replace(/\/+$/, '') : undefined
  if (o.host !== undefined && !host) logger.warn('host must be an http(s) URL')
  const app = o.app && typeof o.app === 'object' ? (o.app as AppInfo) : undefined
  return {
    projectKey: key,
    host: host ?? DEFAULT_HOST,
    app,
    trackLifecycle: o.trackLifecycle !== false,
    consent: o.consent === 'pending' || o.consent === 'denied' ? o.consent : 'granted',
    flushAt: integerInRange(o.flushAt, 1, 500, 20),
    flushIntervalMs: integerInRange(o.flushIntervalMs, 1000, 600_000, 15_000),
    maxQueueSize: integerInRange(o.maxQueueSize, 100, 10_000, 10_000),
    debug: o.debug === true,
  }
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Web Crypto where the runtime has it (Hermes in recent React Native, or the
 * react-native-get-random-values polyfill). Otherwise Math.random: ids stay
 * unique enough for analytics, but aren't unguessable.
 */
function secureOrFallbackRandom(logger: { debug(...args: unknown[]): void }): RandomBytes {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto
  if (typeof crypto?.getRandomValues === 'function') return (bytes) => crypto.getRandomValues!(bytes)
  logger.debug('crypto.getRandomValues missing; ids use Math.random (install react-native-get-random-values for secure ids)')
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    return bytes
  }
}
