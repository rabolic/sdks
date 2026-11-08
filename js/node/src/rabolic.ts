import {
  buildEvent,
  createDispatcher,
  createEventQueue,
  createLogger,
  eventNameProblem,
  fetchTransport,
  idProblem,
  MAX_ANONYMOUS_ID_LENGTH,
  MAX_EVENT_BYTES,
  MAX_USER_ID_LENGTH,
  mathRandomFraction,
  sanitizeProperties,
  serializedSize,
  systemClock,
  uuidv7,
  type Clock,
  type Dispatcher,
  type EventQueue,
  type EventType,
  type Logger,
  type Properties,
  type RandomFraction,
  type Timers,
  type Transport,
} from '@rabolic/sdk-core'
import { eventIdFor } from './idempotency'
import { resolveOptions, type RabolicOptions, type ResolvedOptions } from './options'
import { VERSION } from './version'

/** Who an event is about. At least one is required. */
export interface PersonIds {
  userId?: string
  anonymousId?: string
}

export interface TrackInput extends PersonIds {
  /** Event name: snake_case, may not start with `$`. */
  event: string
  properties?: Properties
  /** When it happened. Default: now. */
  timestamp?: Date | string | number
  /** Same key, same `event_id`: retries and redeliveries are deduplicated server-side. */
  idempotencyKey?: string
}

export interface IdentifyInput extends PersonIds {
  userId: string
  traits?: Properties
}

export interface RevenueInput extends PersonIds {
  /** In major units, such as 9.99. */
  amount: number
  /** ISO 4217 code, such as `USD`. */
  currency: string
  /** The payment provider's transaction id. Also the default idempotency key. */
  transactionId: string
  /** Product or plan identifier. */
  product: string
  properties?: Properties
  timestamp?: Date | string | number
  idempotencyKey?: string
}

/** Metadata to attach to a Stripe or Dodo checkout session, so the payment links to the person. */
export interface CheckoutMetadata {
  rabolic_user_id?: string
  rabolic_anonymous_id?: string
}

/** Test seams. Everything defaults to the real runtime. */
export interface NodeEnvironment {
  transport?: Transport
  clock?: Clock
  timers?: Timers
  random?: RandomFraction
}

/** Timers that never keep the process alive on their own; `shutdown()` is what drains the queue. */
const unrefTimers: Timers = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    // Node and Bun return an object with unref(); Deno returns a number.
    ;(timer as { unref?: () => void }).unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

interface CaptureFields {
  type: EventType
  event: string
  ids: PersonIds
  properties?: Properties
  traits?: Properties
  timestamp?: Date | string | number
  idempotencyKey?: string
}

/**
 * Server-side Rabolic client. Methods never throw or reject: invalid calls are
 * dropped and logged with `debug: true`. Call `shutdown()` before the process exits.
 */
export class Rabolic {
  readonly #options: ResolvedOptions
  readonly #logger: Logger
  readonly #clock: Clock
  readonly #timers: Timers
  readonly #queue: EventQueue
  readonly #dispatcher: Dispatcher
  #flushTimer: unknown
  #shutdown: Promise<void> | undefined

  constructor(options: RabolicOptions, environment: NodeEnvironment = {}) {
    this.#options = resolveOptions(options)
    const { debug, host, maxQueueSize, secretKey, timeoutMs } = this.#options
    this.#logger = createLogger(() => debug)
    this.#clock = environment.clock ?? systemClock
    this.#timers = environment.timers ?? unrefTimers
    this.#queue = createEventQueue({ maxSize: maxQueueSize, logger: this.#logger })
    this.#dispatcher = createDispatcher({
      queue: this.#queue,
      transport: environment.transport ?? fetchTransport(),
      clock: this.#clock,
      timers: this.#timers,
      random: environment.random ?? mathRandomFraction,
      logger: this.#logger,
      batchUrl: `${host}/v1/batch`,
      library: { name: 'rabolic-node', version: VERSION },
      key: secretKey,
      keyPlacement: 'header',
      timeoutMs,
    })
    this.#scheduleFlush()
  }

  /** Queues a custom event. Resolves once queued; `flush()` or `shutdown()` sends it. */
  async track(input: TrackInput): Promise<void> {
    if (eventNameProblem(input?.event)) return this.#drop(input?.event, eventNameProblem(input?.event))
    const { event, properties, timestamp, idempotencyKey } = input
    this.#capture({ type: 'track', event, ids: input, properties, timestamp, idempotencyKey })
  }

  /** Sets person traits and links `anonymousId` (when given) to `userId`. */
  async identify(input: IdentifyInput): Promise<void> {
    if (idProblem(input?.userId, 'userId', MAX_USER_ID_LENGTH)) return this.#drop('$identify', 'identify needs a userId')
    this.#capture({ type: 'identify', event: '$identify', ids: input, traits: input.traits })
  }

  /** A verified purchase: `$purchase` with `amount`, `currency`, `transaction_id` and `product`. */
  purchase(input: RevenueInput): Promise<void> {
    return this.#revenue('$purchase', input)
  }

  /** A subscription renewal: `$renewal`. */
  renewal(input: RevenueInput): Promise<void> {
    return this.#revenue('$renewal', input)
  }

  /** A refund: `$refund`, with the refunded `amount` as a positive number. */
  refund(input: RevenueInput): Promise<void> {
    return this.#revenue('$refund', input)
  }

  /** Sends everything queued. Resolves when done or when the server asked to wait; never rejects. */
  flush(): Promise<void> {
    return this.#dispatcher.flush()
  }

  /**
   * Stops the flush timer and sends everything queued, skipping any backoff
   * wait. Idempotent: later calls return the same promise. Events tracked
   * after shutdown are dropped.
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#timers.clearTimeout(this.#flushTimer)
      await this.#dispatcher.flush({ force: true })
      if (this.#queue.size > 0) this.#logger.warn(`shutdown: ${this.#queue.size} event(s) could not be delivered`)
    })()
    return this.#shutdown
  }

  /** Metadata for a checkout session, to link the payment webhook to the person (backend-plan §9). */
  checkoutMetadata(ids: PersonIds): CheckoutMetadata {
    return checkoutMetadata(ids)
  }

  async #revenue(event: '$purchase' | '$renewal' | '$refund', input: RevenueInput): Promise<void> {
    const problem = revenueProblem(input)
    if (problem) return this.#drop(event, problem)
    const { amount, currency, transactionId, product } = input
    this.#capture({
      type: 'track',
      event,
      ids: input,
      timestamp: input.timestamp,
      idempotencyKey: input.idempotencyKey ?? transactionId,
      properties: { ...input.properties, amount, currency: currency.toUpperCase(), transaction_id: transactionId, product },
    })
  }

  #capture(fields: CaptureFields): void {
    try {
      if (this.#shutdown) return this.#drop(fields.event, 'client is shut down')
      const { userId, anonymousId } = fields.ids ?? {}
      const userProblem = userId === undefined ? undefined : idProblem(userId, 'userId', MAX_USER_ID_LENGTH)
      const anonProblem = anonymousId === undefined ? undefined : idProblem(anonymousId, 'anonymousId', MAX_ANONYMOUS_ID_LENGTH)
      if (userProblem || anonProblem) return this.#drop(fields.event, userProblem ?? anonProblem)
      // The schema requires anonymous_id; with only a user id, it doubles as one (protocol §4).
      const anonymous = anonymousId ?? userId
      if (anonymous === undefined) return this.#drop(fields.event, 'needs userId or anonymousId')
      if (anonymous.length > MAX_ANONYMOUS_ID_LENGTH) return this.#drop(fields.event, 'userId over 128 characters needs an anonymousId')

      const timestampMs = toTimestampMs(fields.timestamp, this.#clock.now())
      if (timestampMs === undefined) return this.#drop(fields.event, 'invalid timestamp')
      const report = (issue: string): void => this.#logger.debug(`"${fields.event}": ${issue}`)
      if (fields.idempotencyKey !== undefined && (typeof fields.idempotencyKey !== 'string' || fields.idempotencyKey === '')) {
        return this.#drop(fields.event, 'idempotencyKey must be a non-empty string')
      }
      const event = buildEvent({
        eventId: fields.idempotencyKey ? eventIdFor(fields.event, fields.idempotencyKey) : uuidv7(this.#clock.now()),
        type: fields.type,
        event: fields.event,
        timestampMs,
        anonymousId: anonymous,
        userId,
        properties: sanitizeProperties(fields.properties, report),
        traits: sanitizeProperties(fields.traits, report),
      })
      if (serializedSize(event) > MAX_EVENT_BYTES) return this.#drop(fields.event, `over ${MAX_EVENT_BYTES} bytes`)
      this.#queue.enqueue(event, this.#clock.now())
      this.#logger.debug(`queued "${event.event}"`, event)
      if (this.#queue.size >= this.#options.flushAt) void this.flush()
    } catch (error) {
      this.#drop(fields.event, String(error))
    }
  }

  #drop(event: unknown, reason: string | undefined): void {
    this.#logger.debug(`"${String(event)}" dropped: ${reason ?? 'invalid'}`)
  }

  #scheduleFlush(): void {
    this.#flushTimer = this.#timers.setTimeout(() => {
      void this.flush()
      if (!this.#shutdown) this.#scheduleFlush()
    }, this.#options.flushIntervalMs)
  }
}

/** Builds `{ rabolic_user_id, rabolic_anonymous_id }` for Stripe or Dodo checkout metadata, leaving out what is not set. */
export function checkoutMetadata(ids: PersonIds): CheckoutMetadata {
  const metadata: CheckoutMetadata = {}
  if (!idProblem(ids?.userId, 'userId', MAX_USER_ID_LENGTH)) metadata.rabolic_user_id = ids.userId
  if (!idProblem(ids?.anonymousId, 'anonymousId', MAX_ANONYMOUS_ID_LENGTH)) metadata.rabolic_anonymous_id = ids.anonymousId
  return metadata
}

function revenueProblem(input: RevenueInput | undefined): string | undefined {
  if (typeof input !== 'object' || input === null) return 'needs an object'
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) return 'amount must be a finite number'
  if (typeof input.currency !== 'string' || !/^[a-z]{3}$/i.test(input.currency)) return 'currency must be an ISO 4217 code'
  if (idProblem(input.transactionId, 'transactionId', 255)) return 'transactionId must be 1-255 characters'
  if (idProblem(input.product, 'product', 255)) return 'product must be 1-255 characters'
  return undefined
}

function toTimestampMs(value: Date | string | number | undefined, now: number): number | undefined {
  if (value === undefined) return now
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined
}
