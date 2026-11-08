import { createDispatcher, type Dispatcher } from './dispatcher'
import { buildEvent, serializedSize } from './event'
import { uuidv4, uuidv7 } from './ids'
import type { Logger } from './logger'
import {
  cryptoRandomBytes,
  mathRandomFraction,
  systemClock,
  systemTimers,
  type Clock,
  type RandomBytes,
  type RandomFraction,
  type Timers,
} from './platform'
import { createEventQueue, type EventQueue } from './queue'
import { createRemoteConfigLoader, isSampledIn, type RemoteConfig } from './remote-config'
import {
  eventNameProblem,
  idProblem,
  MAX_ANONYMOUS_ID_LENGTH,
  MAX_EVENT_BYTES,
  MAX_USER_ID_LENGTH,
  mergeProperties,
  sanitizeProperties,
} from './sanitize'
import { createSessionManager, type SessionManager } from './session'
import { createConsentGatedStore, readJson, safeStore, writeJson, type KeyValueStore } from './storage'
import type { Transport } from './transport'
import type { ConsentState, EventContext, EventType, LibraryInfo, Properties, WireEvent } from './types'

/** Storage keys shared by client SDKs. `rb_aid` and `rb_queue` are fixed by the protocol. */
export const STORAGE_KEYS = {
  anonymousId: 'rb_aid',
  userId: 'rb_uid',
  session: 'rb_session',
  queue: 'rb_queue',
  superProperties: 'rb_super',
  config: 'rb_config',
} as const

export interface DeviceClientOptions {
  key: string
  /** Base URL without a trailing slash. */
  host: string
  library: LibraryInfo
  platform: 'web' | 'ios' | 'android'
  store: KeyValueStore
  transport: Transport
  logger: Logger
  consent: ConsentState
  flushAt: number
  flushIntervalMs: number
  maxQueueSize: number
  /** Session timeout for the current remote config. */
  sessionTimeoutMs: (config: RemoteConfig) => number
  /** Platform context for an event created now. */
  getContext: () => EventContext
  keyPlacement: 'header' | 'body'
  timeoutMs?: number
  clock?: Clock
  timers?: Timers
  randomBytes?: RandomBytes
  random?: RandomFraction
}

export interface CaptureInput {
  type: EventType
  event: string
  properties?: Properties
  traits?: Properties
  /** Merged over the platform context. */
  context?: EventContext
  /** Lets the SDK itself send `$` names such as `$pageview`. */
  reserved?: boolean
}

/**
 * The shared engine of the client SDKs (web today, React Native next): ids,
 * sessions, super properties, consent, remote config, queue and sending.
 * Methods never throw; problems are logged.
 */
export interface DeviceClient {
  readonly session: SessionManager
  readonly queue: EventQueue
  readonly dispatcher: Dispatcher
  readonly anonymousId: string
  readonly userId: string | undefined
  readonly consentState: ConsentState
  readonly remoteConfig: RemoteConfig
  /** Starts the flush timer and fetches remote config in the background. */
  start(): void
  /** Stops timers. Queued events stay queued (and persisted, with consent). */
  stop(): void
  /** Builds and queues an event. Returns it, or `undefined` when it was dropped. */
  capture(input: CaptureInput): WireEvent | undefined
  identify(userId: unknown, traits?: Properties): void
  /** Logout: new anonymous id, no user id, no super properties, new session. */
  reset(): void
  /** Super properties: sent with every later event; event properties win on conflicts. */
  register(properties: Properties): void
  unregister(key: string): void
  /** Protocol §7 consent states. */
  setConsent(state: ConsentState): void
  flush(): Promise<void>
}

export function createDeviceClient(options: DeviceClientOptions): DeviceClient {
  const { logger, flushAt } = options
  const clock = options.clock ?? systemClock
  const timers = options.timers ?? systemTimers
  const randomBytes = options.randomBytes ?? cryptoRandomBytes
  const timeoutMs = options.timeoutMs ?? 10_000
  let consent = options.consent
  let stopped = false
  let flushTimer: unknown

  const store = createConsentGatedStore(
    safeStore(options.store, (error) => logger.debug('storage failed', error)),
    consent === 'granted',
  )
  const config = createRemoteConfigLoader({ ...options, store, storageKey: STORAGE_KEYS.config, clock, timers, timeoutMs })
  const session = createSessionManager({
    store,
    storageKey: STORAGE_KEYS.session,
    clock,
    timeoutMs: options.sessionTimeoutMs(config.config),
    random: randomBytes,
  })
  const queue = createEventQueue({ maxSize: options.maxQueueSize, store, storageKey: STORAGE_KEYS.queue, logger })
  const dispatcher = createDispatcher({
    ...options,
    queue,
    clock,
    timers,
    random: options.random ?? mathRandomFraction,
    batchUrl: `${options.host}/v1/batch`,
    timeoutMs,
    canSend: () => consent === 'granted' && config.config.enabled,
  })

  const storedId = (key: string, maxLength: number): string | undefined => {
    const value = store.get(key)
    return value !== null && !idProblem(value, key, maxLength) ? value : undefined
  }
  let anonymousId = storedId(STORAGE_KEYS.anonymousId, MAX_ANONYMOUS_ID_LENGTH) ?? newAnonymousId()
  let userId = storedId(STORAGE_KEYS.userId, MAX_USER_ID_LENGTH)
  let superProperties: Properties = sanitizeProperties(readJson(store, STORAGE_KEYS.superProperties)) ?? {}
  if (consent === 'denied') forgetEverything()

  function newAnonymousId(): string {
    const id = uuidv4(randomBytes)
    store.set(STORAGE_KEYS.anonymousId, id)
    return id
  }

  function setSuperProperties(next: Properties): void {
    superProperties = next
    writeJson(store, STORAGE_KEYS.superProperties, next)
  }

  /** `denied`: clear the queue and every persisted value, and continue with a fresh in-memory identity. */
  function forgetEverything(): void {
    queue.clear()
    store.wipe(Object.values(STORAGE_KEYS))
    store.buffer()
    anonymousId = uuidv4(randomBytes)
    userId = undefined
    superProperties = {}
  }

  function applyConfig(next: RemoteConfig): void {
    session.setTimeoutMs(options.sessionTimeoutMs(next))
    if (!next.enabled && queue.size > 0) {
      logger.debug('disabled remotely; queue cleared')
      queue.clear()
    }
  }

  function scheduleFlushTimer(): void {
    if (stopped) return
    flushTimer = timers.setTimeout(() => {
      void flush()
      scheduleFlushTimer()
    }, options.flushIntervalMs)
  }

  function flush(): Promise<void> {
    return dispatcher.flush()
  }

  function capture(input: CaptureInput): WireEvent | undefined {
    const drop = (reason: string): undefined => {
      logger.debug(`"${String(input.event)}" dropped: ${reason}`)
      return undefined
    }
    try {
      const remote = config.config
      const problem = eventNameProblem(input.event, input.reserved)
      if (consent === 'denied') return drop('consent denied')
      if (!remote.enabled) return drop('disabled remotely')
      if (problem) return drop(problem)
      if (remote.blockedEvents.includes(input.event)) return drop('blocked remotely')
      if (!isSampledIn(anonymousId, remote.sampleRate)) return drop('not sampled')

      const report = (issue: string): void => logger.debug(`"${input.event}": ${issue}`)
      const now = clock.now()
      const isIdentify = input.type === 'identify'
      const event = buildEvent({
        eventId: uuidv7(now, randomBytes),
        type: input.type,
        event: input.event,
        timestampMs: now,
        anonymousId,
        userId,
        sessionId: session.touch(now),
        properties: isIdentify ? undefined : sanitizeProperties(mergeProperties(superProperties, input.properties), report),
        traits: isIdentify ? sanitizeProperties(input.traits, report) : undefined,
        context: { ...options.getContext(), ...input.context, platform: options.platform },
      })
      if (serializedSize(event) > MAX_EVENT_BYTES) return drop(`over ${MAX_EVENT_BYTES} bytes`)

      queue.enqueue(event, now)
      logger.debug(`queued "${event.event}"`, event)
      if (queue.size >= flushAt) void flush()
      return event
    } catch (error) {
      return drop(String(error))
    }
  }

  return {
    session,
    queue,
    dispatcher,
    get anonymousId() {
      return anonymousId
    },
    get userId() {
      return userId
    },
    get consentState() {
      return consent
    },
    get remoteConfig() {
      return config.config
    },
    start() {
      applyConfig(config.config)
      scheduleFlushTimer()
      void config.refresh().then((result) => {
        if (result.status === 'unauthorized') dispatcher.stopForUnauthorized()
        else if (result.status === 'ok') applyConfig(result.config)
      })
    },
    stop() {
      stopped = true
      timers.clearTimeout(flushTimer)
      dispatcher.cancelRetry()
    },
    capture,
    identify(id, traits) {
      const problem = idProblem(id, 'userId', MAX_USER_ID_LENGTH)
      if (problem || typeof id !== 'string') {
        logger.debug(`identify: ${problem ?? 'invalid userId'}`)
        return
      }
      userId = id
      store.set(STORAGE_KEYS.userId, id)
      capture({ type: 'identify', event: '$identify', traits, reserved: true })
    },
    reset() {
      anonymousId = newAnonymousId()
      userId = undefined
      store.remove(STORAGE_KEYS.userId)
      setSuperProperties({})
      session.start(clock.now())
    },
    register(properties) {
      const clean = sanitizeProperties(properties, (issue) => logger.debug(`register: ${issue}`))
      if (clean) setSuperProperties(mergeProperties(superProperties, clean))
    },
    unregister(key) {
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(superProperties, key)) return
      const next = mergeProperties(superProperties)
      delete next[key]
      setSuperProperties(next)
    },
    setConsent(state) {
      if (state !== 'granted' && state !== 'pending' && state !== 'denied') {
        logger.debug('setConsent: unknown state')
        return
      }
      consent = state
      if (state === 'granted') {
        store.persist()
        void flush()
      } else if (state === 'pending') store.buffer()
      else forgetEverything()
    },
    flush,
  }
}
