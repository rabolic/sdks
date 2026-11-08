import { describe, expect, it } from 'vitest'
import { createSessionManager, MemoryStore, uuidv7Time } from '../src'

const MIN = 60_000

function manager(store = new MemoryStore(), timeoutMs = 30 * MIN) {
  let now = Date.parse('2026-11-08T10:00:00Z')
  const clock = { now: () => now }
  const session = createSessionManager({ store, storageKey: 'rb_session', clock, timeoutMs })
  return { session, store, advance: (ms: number) => (now += ms), now: () => now }
}

describe('SessionManager', () => {
  it('keeps the session while events arrive within the timeout', () => {
    const { session, advance } = manager()
    const id = session.touch()
    advance(29 * MIN)
    expect(session.touch()).toBe(id)
    advance(29 * MIN)
    expect(session.touch()).toBe(id)
  })

  it('starts a new session after more than 30 minutes without events, timestamped at the start', () => {
    const { session, advance, now } = manager()
    const id = session.touch()
    advance(30 * MIN + 1)
    const next = session.touch()
    expect(next).not.toBe(id)
    expect(uuidv7Time(next)).toBe(now())
  })

  it('honours a timeout changed by remote config', () => {
    const { session, advance } = manager()
    const id = session.touch()
    session.setTimeoutMs(5 * MIN)
    advance(6 * MIN)
    expect(session.touch()).not.toBe(id)
  })

  it('starts a new session when campaign parameters differ, not when they repeat or are absent', () => {
    const { session, advance } = manager()
    session.applyCampaign('utm_source=google')
    const id = session.touch()
    advance(MIN)
    session.applyCampaign('utm_source=google')
    session.applyCampaign(undefined)
    expect(session.touch()).toBe(id)
    session.applyCampaign('utm_source=newsletter')
    expect(session.touch()).not.toBe(id)
  })

  it('is shared across tabs through shared storage', () => {
    const store = new MemoryStore()
    const tabA = manager(store)
    const tabB = manager(store)
    const id = tabA.session.touch()
    tabB.advance(20 * MIN)
    expect(tabB.session.touch()).toBe(id)
    tabA.advance(40 * MIN)
    // Tab B's event 20 minutes in kept the shared session alive for tab A.
    expect(tabA.session.touch()).toBe(id)
  })

  it('start() (reset) begins a new session', () => {
    const { session } = manager()
    const id = session.touch()
    session.start()
    expect(session.touch()).not.toBe(id)
  })

  it('recovers from corrupt stored state', () => {
    const store = new MemoryStore()
    store.set('rb_session', '{"id":"not-a-uuid","lastActivity":1}')
    const { session } = manager(store)
    expect(session.touch()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
