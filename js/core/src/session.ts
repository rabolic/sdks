import { isUuid, uuidv7 } from './ids'
import type { Clock, RandomBytes } from './platform'
import { readJson, writeJson, type KeyValueStore } from './storage'

export interface SessionState {
  id: string
  /** Unix ms of the last event in the session. */
  lastActivity: number
  /** Signature of the campaign parameters the session started with. */
  campaign?: string
}

export interface SessionOptions {
  store: KeyValueStore
  storageKey: string
  clock: Clock
  timeoutMs: number
  random?: RandomBytes
}

/**
 * Session ids per protocol §4. State lives in the store and is re-read on every
 * call, so tabs sharing `localStorage` share a session. Platform packages add
 * their own triggers (page load campaigns, app foreground) on top.
 */
export interface SessionManager {
  setTimeoutMs(timeoutMs: number): void
  /** The session id for an event happening at `now`, starting a new session when the last one expired. */
  touch(now?: number): string
  /** A page or app opened with campaign parameters: start a new session unless the live one started with the same ones. */
  applyCampaign(signature: string | undefined, now?: number): void
  /** Starts a new session (after `reset()`, on app launch). */
  start(now?: number, campaign?: string): SessionState
}

export function createSessionManager({ store, storageKey, clock, timeoutMs, random }: SessionOptions): SessionManager {
  let timeout = timeoutMs
  const isLive = (state: SessionState | undefined, now: number): state is SessionState =>
    state !== undefined && now - state.lastActivity <= timeout

  function read(): SessionState | undefined {
    const value = readJson(store, storageKey) as Partial<SessionState> | null | undefined
    const { id, lastActivity, campaign } = value ?? {}
    if (!isUuid(id) || typeof lastActivity !== 'number' || !Number.isFinite(lastActivity)) return undefined
    return typeof campaign === 'string' ? { id, lastActivity, campaign } : { id, lastActivity }
  }

  function start(now = clock.now(), campaign?: string): SessionState {
    const state: SessionState = { id: uuidv7(now, random), lastActivity: now }
    if (campaign) state.campaign = campaign
    writeJson(store, storageKey, state)
    return state
  }

  return {
    setTimeoutMs(next) {
      timeout = next
    },
    touch(now = clock.now()) {
      const state = read()
      if (!isLive(state, now)) return start(now).id
      writeJson(store, storageKey, { ...state, lastActivity: Math.max(state.lastActivity, now) })
      return state.id
    },
    applyCampaign(signature, now = clock.now()) {
      const state = read()
      if (signature && !(isLive(state, now) && state.campaign === signature)) start(now, signature)
    },
    start,
  }
}
