import { toIsoTimestamp } from './event'
import type { Logger } from './logger'
import type { Clock, RandomFraction, TimerHandle, Timers } from './platform'
import type { EventQueue, QueuedEvent } from './queue'
import { sendWithTimeout, type HttpResponse, type Transport } from './transport'
import type { BatchEnvelope, BatchResult, LibraryInfo, WireEvent } from './types'

export const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BACKOFF_MS = 300_000
const BASE_BACKOFF_MS = 1_000

export interface DispatcherOptions {
  queue: EventQueue
  transport: Transport
  clock: Clock
  timers: Timers
  random: RandomFraction
  logger: Logger
  /** Full URL of `POST /v1/batch`. */
  batchUrl: string
  library: LibraryInfo
  key: string
  /**
   * `header`: `Authorization: Bearer` with `application/json` (servers).
   * `body`: the key in the envelope, sent as `text/plain`, so browsers need no
   * CORS preflight (protocol §1).
   */
  keyPlacement: 'header' | 'body'
  timeoutMs?: number
  /** Checked before every request: consent, remote kill switch and so on. */
  canSend?: () => boolean
}

/**
 * Sends the queue in batches, one request at a time, applying the response
 * rules of protocol §1 and the backoff of §5.
 */
export interface Dispatcher {
  /** True after a `401`: nothing is sent again in this process. */
  readonly stopped: boolean
  /** True while waiting out a backoff or `Retry-After`. */
  readonly waitingToRetry: boolean
  /**
   * Sends queued events until the queue is empty or a response says to wait.
   * Resolves when that pass ends; never rejects. `force` skips a pending
   * backoff wait (used by `shutdown`), never a `401` stop.
   */
  flush(options?: { force?: boolean }): Promise<void>
  /**
   * Hands queued events to a fire-and-forget sender such as `navigator.sendBeacon`,
   * for when the page may be gone before a normal request finishes. Skips events
   * in flight, and does nothing while the server asked us to back off.
   */
  sendUnreliably(send: (body: string) => boolean, maxBytes: number): void
  /** Protocol §1 `401`: stop sending for the rest of the process and keep the queue. Logs once. */
  stopForUnauthorized(): void
  /** Cancels a scheduled retry. Queued events stay queued. */
  cancelRetry(): void
}

type Outcome = 'continue' | 'halt'

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { queue, transport, clock, timers, random, logger, key, keyPlacement } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const inFlight = new Set<string>()
  let running: Promise<void> | undefined
  let retryTimer: TimerHandle | undefined
  let attempt = 0
  let unauthorized = false

  const allowed = (): boolean => !unauthorized && (options.canSend?.() ?? true)

  /** `sent_at` is stamped here, at send time (protocol §2). */
  function serialize(events: WireEvent[], keyInBody: boolean): string {
    const envelope: BatchEnvelope = { sent_at: toIsoTimestamp(clock.now()), library: options.library, events }
    if (keyInBody) envelope.key = key
    return JSON.stringify(envelope)
  }

  function cancelRetry(): void {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
    retryTimer = undefined
  }

  function scheduleRetry(delayMs: number): void {
    cancelRetry()
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined
      void flush()
    }, delayMs)
  }

  /** `min(300 s, 1 s × 2^attempt) × random(0.5–1.0)`; `attempt` counts consecutive failures, from 0. */
  function nextBackoff(): number {
    const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt++)
    return base * (0.5 + 0.5 * random())
  }

  function stopForUnauthorized(): void {
    if (unauthorized) return
    unauthorized = true
    cancelRetry()
    logger.warn('key rejected (401); sending stopped')
  }

  async function send(batch: QueuedEvent[]): Promise<Outcome> {
    const ids = batch.map((item) => item.event.event_id)
    const headers: Record<string, string> =
      keyPlacement === 'header'
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
        : { 'Content-Type': 'text/plain;charset=UTF-8' }
    const body = serialize(
      batch.map((item) => item.event),
      keyPlacement === 'body',
    )
    let response: HttpResponse
    ids.forEach((id) => inFlight.add(id))
    try {
      response = await sendWithTimeout(transport, { method: 'POST', url: options.batchUrl, headers, body }, timeoutMs, timers)
    } catch (error) {
      logger.debug('request failed; retrying', error)
      scheduleRetry(nextBackoff())
      return 'halt'
    } finally {
      inFlight.clear()
    }

    const { status } = response
    if (status >= 200 && status < 300) {
      queue.remove(ids)
      attempt = 0
      logResult(response.body, batch)
      return 'continue'
    }
    if (status === 401) {
      stopForUnauthorized()
      return 'halt'
    }
    if (status === 413) return split(batch)
    if (status === 429) {
      scheduleRetry(parseRetryAfter(response.retryAfter) ?? nextBackoff())
      return 'halt'
    }
    // 408 is a timeout reported by a proxy: retried like one, as in the other SDKs.
    if (status >= 400 && status < 500 && status !== 408) {
      queue.remove(ids)
      logger.warn(`batch dropped (${status})`, response.body)
      return 'continue'
    }
    logger.debug(`status ${status}; retrying`)
    scheduleRetry(nextBackoff())
    return 'halt'
  }

  /** `413`: retry each half; a single event that is still too large is dropped. */
  async function split(batch: QueuedEvent[]): Promise<Outcome> {
    const [single] = batch
    if (batch.length === 1 && single) {
      queue.remove([single.event.event_id])
      logger.warn(`"${single.event.event}" too large; dropped`)
      return 'continue'
    }
    const middle = Math.ceil(batch.length / 2)
    for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
      if (!allowed() || (await send(half)) === 'halt') return 'halt'
    }
    return 'continue'
  }

  /** A 200 body only informs: rejected and dropped events are final (protocol §1). */
  function logResult(body: string, batch: QueuedEvent[]): void {
    try {
      const { rejected = [], dropped } = JSON.parse(body) as Partial<BatchResult>
      for (const { index, reason } of rejected) logger.debug(`"${batch[index]?.event.event ?? index}" rejected: ${reason}`)
      if (dropped) logger.debug(`${dropped} dropped: monthly cap`)
    } catch {
      // Not the documented body; nothing to report.
    }
  }

  async function drain(): Promise<void> {
    while (allowed()) {
      const batch = queue.peekBatch(clock.now())
      if (batch.length === 0 || (await send(batch)) === 'halt') return
    }
  }

  function flush(flushOptions: { force?: boolean } = {}): Promise<void> {
    const { force = false } = flushOptions
    // A pass in progress may have already seen an empty queue: run another one after it.
    if (running) return running.then(() => flush(flushOptions))
    if (unauthorized || (retryTimer !== undefined && !force)) return Promise.resolve()
    cancelRetry()
    running = drain()
      .catch((error: unknown) => logger.debug('flush failed', error))
      .finally(() => {
        running = undefined
      })
    return running
  }

  return {
    get stopped() {
      return unauthorized
    },
    get waitingToRetry() {
      return retryTimer !== undefined
    },
    flush,
    stopForUnauthorized,
    cancelRetry,
    sendUnreliably(sendNow, maxBytes) {
      if (retryTimer !== undefined || !allowed()) return
      // Ends when the queue is empty or the sender refuses (the beacon quota is spent).
      for (;;) {
        const batch = queue.peekBatch(clock.now(), 500, maxBytes).filter((item) => !inFlight.has(item.event.event_id))
        if (batch.length === 0 || !sendNow(serialize(batch.map((item) => item.event), true))) return
        queue.remove(batch.map((item) => item.event.event_id))
      }
    },
  }
}

/** `Retry-After` in seconds (protocol §1), as ms; `undefined` when missing or malformed. */
export function parseRetryAfter(value: string | null): number | undefined {
  return value !== null && /^\s*\d+\s*$/.test(value) ? Number(value) * 1000 : undefined
}
