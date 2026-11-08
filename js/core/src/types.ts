/** Wire types from `spec/protocol.md` §2. Field names match the JSON on the wire. */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** What callers may pass as properties or traits. Unsupported values are dropped during sanitizing. */
export type Properties = Record<string, unknown>

export type EventType = 'track' | 'page' | 'screen' | 'identify'

export type LibraryName =
  | 'rabolic-web'
  | 'rabolic-node'
  | 'rabolic-react-native'
  | 'rabolic-ios'
  | 'rabolic-android'
  | 'rabolic-flutter'
  | 'http'

export interface LibraryInfo {
  name: LibraryName
  version: string
}

export type ClickId = 'gclid' | 'fbclid' | 'ttclid' | 'msclkid'

export interface CampaignContext {
  source?: string
  medium?: string
  name?: string
  content?: string
  term?: string
  click_id?: ClickId
}

export interface PageContext {
  url?: string
  path?: string
  title?: string
  referrer?: string
}

export interface EventContext {
  platform?: 'web' | 'ios' | 'android'
  app?: { version?: string; build?: string; bundle?: string }
  device?: { type?: 'mobile' | 'tablet' | 'desktop' | 'tv'; model?: string; manufacturer?: string }
  os?: { name?: string; version?: string }
  browser?: { name?: string; version?: string }
  locale?: string
  timezone?: string
  screen?: { width?: number; height?: number; density?: number }
  page?: PageContext
  campaign?: CampaignContext
  screen_name?: string
  user_agent?: string
}

export interface WireEvent {
  event_id: string
  type: EventType
  event: string
  timestamp: string
  anonymous_id: string
  user_id?: string | null
  session_id?: string
  properties?: JsonObject
  traits?: JsonObject
  context?: EventContext
}

export interface BatchEnvelope {
  key?: string
  sent_at: string
  library: LibraryInfo
  events: WireEvent[]
}

export interface RejectedEvent {
  index: number
  reason: string
}

/** Body of a `200` from `POST /v1/batch`. */
export interface BatchResult {
  accepted: number
  rejected: RejectedEvent[]
  dropped: number
}

export type ConsentState = 'granted' | 'pending' | 'denied'
