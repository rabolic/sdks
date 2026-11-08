import {
  createLogger,
  createDeviceClient,
  fetchTransport,
  systemClock,
  systemTimers,
  type Clock,
  type DeviceClient,
  type ConsentState,
  type RemoteConfig,
  type Properties,
  type RandomFraction,
  type Timers,
  type Transport,
} from '@rabolic/sdk-core'
import { createWebStore } from './browser-storage'
import { parseCampaign } from './campaign'
import { staticContext } from './context'
import { resolveOptions, type ResolvedWebOptions, type WebOptions } from './options'
import { startPageTracker, type PageTracker } from './page-tracker'
import { VERSION } from './version'

/** Chrome caps all in-flight beacons of a page at 64 KB. */
const BEACON_MAX_BYTES = 60_000
/** Calls made before `init` are kept and replayed, up to this many. */
const MAX_EARLY_CALLS = 100
const WEB_MAX_QUEUE = 1000

export interface RabolicWeb {
  init(options: WebOptions): void
  /** A custom event. Names are snake_case and may not start with `$`. */
  track(event: string, properties?: Properties): void
  /** A manual `$pageview`, for when automatic page views are off. */
  page(properties?: Properties): void
  /** Sets `user_id` on this and every later event. */
  identify(userId: string, traits?: Properties): void
  /** Logout: new anonymous id and session, no user id, no super properties. */
  reset(): void
  /** Super properties, sent with every later event. */
  register(properties: Properties): void
  unregister(key: string): void
  setConsent(state: ConsentState): void
  /** Same as `setConsent('denied')`. */
  optOut(): void
  /** Same as `setConsent('granted')`. */
  optIn(): void
  /** Sends queued events now. Resolves when done; never rejects. */
  flush(): Promise<void>
  /** `null` before `init`. */
  getAnonymousId(): string | null
  /** Adds `rb_aid=<anonymous id>` to a store or deep link URL, so the app can link the two visitors. */
  appLink(url: string): string
}

/** Browser and test seams. Everything defaults to the real browser. */
export interface WebEnvironment {
  window?: Window
  transport?: Transport
  clock?: Clock
  timers?: Timers
  random?: RandomFraction
}

/** Creates an independent instance. Most sites use the `rabolic` singleton instead. */
export function createRabolic(environment: WebEnvironment = {}): RabolicWeb {
  let client: DeviceClient | undefined
  let tracker: PageTracker | undefined
  let debug = false
  const early: Array<() => void> = []
  const logger = createLogger(() => debug)
  const win: Window | undefined = environment.window ?? (typeof window === 'undefined' ? undefined : window)
  const clock = environment.clock ?? systemClock

  /**
   * Wraps a public method: runs it once initialized, keeps the call for later
   * before `init`, and never lets an error reach the host page.
   */
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

  function start(options: ResolvedWebOptions, browser: Window): void {
    debug = options.debug
    const fixed = staticContext(browser)
    const landing = parseCampaign(browser.location.search)
    const batchUrl = `${options.host}/v1/batch`
    const sdk = createDeviceClient({
      key: options.projectKey,
      host: options.host,
      library: { name: 'rabolic-web', version: VERSION },
      platform: 'web',
      store: createWebStore(browser, options.persistence, {
        domain: options.cookieDomain,
        secure: browser.location.protocol === 'https:',
      }),
      transport: environment.transport ?? fetchTransport({ credentials: 'omit' }),
      logger,
      consent: options.consent,
      flushAt: options.flushAt,
      flushIntervalMs: options.flushIntervalMs,
      maxQueueSize: WEB_MAX_QUEUE,
      sessionTimeoutMs: (config) => config.sessionTimeoutWebMin * 60_000,
      getContext: () => ({ ...fixed, page: tracker?.currentPage(), campaign: landing?.context }),
      keyPlacement: 'body',
      clock,
      timers: environment.timers ?? systemTimers,
      random: environment.random,
    })
    client = sdk
    sdk.session.applyCampaign(landing?.signature)
    sdk.start()

    /** On page hide: hand the queue to `sendBeacon`, which survives the page closing. */
    const sendBeacon = (): void => {
      const nav = browser.navigator
      if (typeof nav.sendBeacon !== 'function') void sdk.flush()
      // A string body goes out as text/plain;charset=UTF-8, which needs no CORS preflight.
      else sdk.dispatcher.sendUnreliably((body) => nav.sendBeacon(batchUrl, body), BEACON_MAX_BYTES)
    }
    const autocapture = (): RemoteConfig['autocapture'] => sdk.remoteConfig.autocapture
    tracker = startPageTracker(browser, clock, {
      pageview: (page) => {
        if (autocapture().pageviews) sdk.capture({ type: 'page', event: '$pageview', reserved: true, context: { page } })
      },
      pageLeave: (page, metrics) => {
        sdk.capture({ type: 'track', event: '$page_leave', reserved: true, properties: { ...metrics }, context: { page } })
      },
      hidden: sendBeacon,
      trackRoutes: () => options.trackRoutes && autocapture().pageviews,
      trackPageLeave: () => options.trackPageLeave && autocapture().pageLeave,
    })
    logger.debug('initialized', options.host)
  }

  const setConsent = guarded((sdk, state: ConsentState) => sdk.setConsent(state))

  return {
    init(input) {
      try {
        if (client) return
        if (!win) return logger.warn('no window; use @rabolic/node on servers')
        const options = resolveOptions(input, logger)
        if (!options) return
        start(options, win)
        early.splice(0).forEach((call) => call())
      } catch (error) {
        logger.warn('init failed', error)
      }
    },
    track: guarded((sdk, event: string, properties?: Properties) => sdk.capture({ type: 'track', event, properties })),
    page: guarded((sdk, properties?: Properties) =>
      sdk.capture({ type: 'page', event: '$pageview', properties, reserved: true }),
    ),
    identify: guarded((sdk, userId: string, traits?: Properties) => sdk.identify(userId, traits)),
    reset: guarded((sdk) => sdk.reset()),
    register: guarded((sdk, properties: Properties) => sdk.register(properties)),
    unregister: guarded((sdk, key: string) => sdk.unregister(key)),
    setConsent,
    optOut: () => setConsent('denied'),
    optIn: () => setConsent('granted'),
    flush: () => (client ? client.flush() : Promise.resolve()),
    getAnonymousId: () => (client ? client.anonymousId : null),
    appLink(url) {
      // Linking is tracking, so it needs consent like everything else.
      if (!client || client.consentState !== 'granted' || typeof url !== 'string') return url
      try {
        const link = new URL(url, win?.location.href)
        link.searchParams.set('rb_aid', client.anonymousId)
        return link.toString()
      } catch {
        return url
      }
    },
  }
}
