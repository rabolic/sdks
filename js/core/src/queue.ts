import { serializedSize } from './event'
import { isUuid } from './ids'
import type { Logger } from './logger'
import { readJson, writeJson, type KeyValueStore } from './storage'
import type { WireEvent } from './types'

export const MAX_EVENT_AGE_MS: number = 7 * 24 * 60 * 60 * 1000

/** Protocol §5: at most 500 events or 900 KB serialized per batch. */
export const MAX_BATCH_EVENTS: number = 500
export const MAX_BATCH_BYTES: number = 900 * 1024

export interface QueuedEvent {
  event: WireEvent
  /** When the event was created, in Unix ms. Drives the 7-day max age. */
  createdAt: number
  /** Serialized size in UTF-8 bytes. */
  bytes: number
}

export interface QueueOptions {
  maxSize: number
  /** Storage key for persistence; omit to keep the queue in memory. */
  storageKey?: string
  store?: KeyValueStore
  logger: Logger
}

/**
 * Ordered event queue (protocol §5). When full it drops the oldest event;
 * events older than 7 days are dropped before they are handed out.
 */
export interface EventQueue {
  readonly size: number
  enqueue(event: WireEvent, createdAt: number): void
  /** The oldest events that fit in one batch, after dropping expired ones. Does not remove them. */
  peekBatch(now: number, maxEvents?: number, maxBytes?: number): QueuedEvent[]
  /** Removes events by id, which stays correct even if older events were dropped meanwhile. */
  remove(eventIds: Iterable<string>): void
  clear(): void
}

/** Persisted as `{ v: 1, events: [{ e: event, t: createdAt }] }`. */
interface PersistedEntry {
  e: WireEvent
  t: number
}

export function createEventQueue({ maxSize, storageKey, store, logger }: QueueOptions): EventQueue {
  let items = load()

  function save(): void {
    if (!store || !storageKey) return
    if (items.length === 0) store.remove(storageKey)
    else writeJson(store, storageKey, { v: 1, events: items.map((item) => ({ e: item.event, t: item.createdAt })) })
  }

  /** Storage is untrusted (any script on the origin can write it), so every entry is checked. */
  function load(): QueuedEvent[] {
    const persisted = store && storageKey ? (readJson(store, storageKey) as { v?: unknown; events?: unknown } | undefined) : undefined
    if (persisted?.v !== 1 || !Array.isArray(persisted.events)) return []
    return (persisted.events as unknown[])
      .filter(isPersistedEntry)
      .slice(-maxSize)
      .map((entry) => ({ event: entry.e, createdAt: entry.t, bytes: serializedSize(entry.e) }))
  }

  /** Keeps the items matching `predicate`; returns how many were removed. */
  function keep(predicate: (item: QueuedEvent) => boolean): number {
    const before = items.length
    items = items.filter(predicate)
    const removed = before - items.length
    if (removed > 0) save()
    return removed
  }

  return {
    get size() {
      return items.length
    },

    enqueue(event, createdAt) {
      items.push({ event, createdAt, bytes: serializedSize(event) })
      const overflow = items.length - maxSize
      if (overflow > 0) {
        items.splice(0, overflow)
        logger.debug(`queue full; dropped ${overflow} oldest`)
      }
      save()
    },

    peekBatch(now, maxEvents = MAX_BATCH_EVENTS, maxBytes = MAX_BATCH_BYTES) {
      const expired = keep((item) => now - item.createdAt <= MAX_EVENT_AGE_MS)
      if (expired > 0) logger.debug(`dropped ${expired} expired`)
      const batch: QueuedEvent[] = []
      let bytes = 0
      for (const item of items) {
        // Always hand out at least one event, so an oversized one is sent and rejected rather than blocking the queue.
        if (batch.length >= maxEvents || (batch.length > 0 && bytes + item.bytes > maxBytes)) break
        batch.push(item)
        bytes += item.bytes + 1
      }
      return batch
    },

    remove(eventIds) {
      const ids = new Set(eventIds)
      keep((item) => !ids.has(item.event.event_id))
    },

    clear() {
      items = []
      save()
    },
  }
}

/** Enough to send and dedupe safely; the server validates the rest of each event. */
function isPersistedEntry(value: unknown): value is PersistedEntry {
  const entry = value as Partial<PersistedEntry> | null
  return Number.isFinite(entry?.t) && isUuid(entry?.e?.event_id) && typeof entry?.e?.event === 'string'
}
