import { utf8Length } from './ids'
import type { EventContext, EventType, JsonObject, WireEvent } from './types'

export interface EventFields {
  eventId: string
  type: EventType
  event: string
  timestampMs: number
  anonymousId: string
  userId?: string | null
  sessionId?: string
  properties?: JsonObject
  traits?: JsonObject
  context?: EventContext
}

/** RFC 3339 UTC with milliseconds, as the protocol requires for `timestamp` and `sent_at`. */
export function toIsoTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

/** Builds a wire event. Unset and empty optional fields are left out of the JSON. */
export function buildEvent(fields: EventFields): WireEvent {
  return {
    event_id: fields.eventId,
    type: fields.type,
    event: fields.event,
    timestamp: toIsoTimestamp(fields.timestampMs),
    anonymous_id: fields.anonymousId,
    user_id: fields.userId || undefined,
    session_id: fields.sessionId,
    properties: nonEmpty(fields.properties),
    traits: nonEmpty(fields.traits),
    context: nonEmpty(fields.context),
  }
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined
}

export function serializedSize(value: unknown): number {
  return utf8Length(JSON.stringify(value))
}
