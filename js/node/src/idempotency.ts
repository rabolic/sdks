import { createHash } from 'node:crypto'
import { formatUuid, stampUuid } from '@rabolic/sdk-core'

/** Fixed namespace for Rabolic event ids. Every server SDK must use the same one. */
export const EVENT_ID_NAMESPACE = '405a74de-a60c-4882-b7da-344cfaaeb42c'

const namespaceBytes = Buffer.from(EVENT_ID_NAMESPACE.replace(/-/g, ''), 'hex')

/**
 * The `event_id` for an idempotency key: UUIDv5 (RFC 9562, SHA-1) of
 * `<event>\n<idempotencyKey>` in the Rabolic namespace. The same call retried,
 * from any process, gets the same id, so the server deduplicates it. The event
 * name is part of the hash so one key (an invoice id) can be reused across events.
 */
export function eventIdFor(event: string, idempotencyKey: string): string {
  const digest = createHash('sha1').update(namespaceBytes).update(`${event}\n${idempotencyKey}`, 'utf8').digest()
  return formatUuid(stampUuid(new Uint8Array(digest.subarray(0, 16)), 5))
}
