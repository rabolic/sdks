import { acceptAll, assertValidBatch } from '@rabolic/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fnv1a32, isSampledIn, MemoryStore, STORAGE_KEYS, uuidv4 } from '../src'
import { makeClient, recordingLogger } from './helpers'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

function answerConfig(config: unknown, status = 200) {
  return (call: { request: { method: string }; respond: (s: number, b?: unknown) => void; body: unknown }) => {
    if (call.request.method === 'GET') call.respond(status, config)
    else call.respond(200, acceptAll(call as never))
  }
}

describe('events', () => {
  it('builds schema-valid batches for track, page and identify', async () => {
    const { client, fake } = makeClient()
    fake.autoRespond = answerConfig({ enabled: true })
    client.start()
    client.register({ plan: 'pro' })
    client.capture({ type: 'track', event: 'checkout_started', properties: { price: 79.99, plan: 'annual' } })
    client.capture({ type: 'page', event: '$pageview', reserved: true, context: { page: { path: '/pricing' } } })
    client.identify('usr_1', { email_domain: 'example.com' })
    await client.flush()
    const [batch] = fake.batches
    assertValidBatch(batch)
    const [track, page, identify] = batch!.events as Array<Record<string, any>>
    expect(track!.properties).toEqual({ plan: 'annual', price: 79.99 })
    expect(track!.context.platform).toBe('web')
    expect(track!.context.locale).toBe('en-US')
    expect(page!.type).toBe('page')
    expect(page!.context.page.path).toBe('/pricing')
    expect(identify).toMatchObject({ type: 'identify', event: '$identify', user_id: 'usr_1', traits: { email_domain: 'example.com' } })
    expect(identify!.properties).toBeUndefined()
    expect(new Set(batch!.events.map((event) => event.session_id)).size).toBe(1)
  })

  it('flushes when flushAt events are queued, and on the interval', async () => {
    const { client, fake } = makeClient({ flushAt: 3 })
    fake.autoRespond = answerConfig({})
    client.start()
    client.capture({ type: 'track', event: 'a' })
    client.capture({ type: 'track', event: 'b' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.batches).toHaveLength(0)
    client.capture({ type: 'track', event: 'c' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.batches).toHaveLength(1)
    client.capture({ type: 'track', event: 'd' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.batches).toHaveLength(2)
  })

  it('drops invalid calls without throwing', () => {
    const logger = recordingLogger()
    const { client } = makeClient({ logger })
    expect(client.capture({ type: 'track', event: '$purchase' })).toBeUndefined()
    expect(client.capture({ type: 'track', event: '' })).toBeUndefined()
    expect(client.capture({ type: 'track', event: 'big', properties: { blob: 'x'.repeat(40_000) } })).toBeUndefined()
    expect(() => client.identify(undefined)).not.toThrow()
    expect(() => client.identify('u'.repeat(256))).not.toThrow()
    expect(client.userId).toBeUndefined()
    expect(client.queue.size).toBe(0)
    expect(logger.debugs.length).toBeGreaterThanOrEqual(5)
  })

  it('reset gives a new anonymous id, clears user id and super properties, and starts a new session', () => {
    const { client } = makeClient()
    client.identify('usr_1')
    client.register({ plan: 'pro' })
    const before = client.capture({ type: 'track', event: 'a' })!
    client.reset()
    const after = client.capture({ type: 'track', event: 'b' })!
    expect(after.anonymous_id).not.toBe(before.anonymous_id)
    expect(after.user_id).toBeUndefined()
    expect(after.properties).toBeUndefined()
    expect(after.session_id).not.toBe(before.session_id)
  })

  it('unregister removes one super property', () => {
    const { client } = makeClient()
    client.register({ a: 1, b: 2 })
    client.unregister('a')
    expect(client.capture({ type: 'track', event: 'x' })!.properties).toEqual({ b: 2 })
  })

  it('persists identity across instances sharing storage', () => {
    const store = new MemoryStore()
    const first = makeClient({ store }).client
    first.identify('usr_9')
    const second = makeClient({ store }).client
    expect(second.anonymousId).toBe(first.anonymousId)
    expect(second.userId).toBe('usr_9')
  })
})

describe('consent', () => {
  it('pending keeps events in memory only and sends nothing; granted persists and sends them', async () => {
    const store = new MemoryStore()
    const { client, fake } = makeClient({ store, consent: 'pending' })
    fake.autoRespond = answerConfig({})
    client.start()
    client.capture({ type: 'track', event: 'a' })
    await client.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.batches).toHaveLength(0)
    expect(store.get(STORAGE_KEYS.queue)).toBeNull()
    expect(store.get(STORAGE_KEYS.anonymousId)).toBeNull()

    client.setConsent('granted')
    expect(store.get(STORAGE_KEYS.anonymousId)).toBe(client.anonymousId)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.batches[0]?.events.map((event) => event.event)).toEqual(['a'])
  })

  it('pending still reads an id persisted under earlier consent', () => {
    const store = new MemoryStore()
    const id = uuidv4()
    store.set(STORAGE_KEYS.anonymousId, id)
    expect(makeClient({ store, consent: 'pending' }).client.anonymousId).toBe(id)
  })

  it('denied drops everything, clears the queue and persisted state, and sends nothing', async () => {
    const store = new MemoryStore()
    const { client, fake } = makeClient({ store })
    fake.autoRespond = answerConfig({})
    client.identify('usr_1')
    client.capture({ type: 'track', event: 'a' })
    expect(store.get(STORAGE_KEYS.queue)).not.toBeNull()
    client.setConsent('denied')
    expect(client.queue.size).toBe(0)
    for (const key of Object.values(STORAGE_KEYS)) expect(store.get(key)).toBeNull()
    expect(client.capture({ type: 'track', event: 'b' })).toBeUndefined()
    await client.flush()
    expect(fake.batches).toHaveLength(0)
  })

  it('initial denied wipes previous state', () => {
    const store = new MemoryStore()
    store.set(STORAGE_KEYS.anonymousId, uuidv4())
    makeClient({ store, consent: 'denied' })
    expect(store.get(STORAGE_KEYS.anonymousId)).toBeNull()
  })

  it('ignores unknown consent values', () => {
    const { client } = makeClient()
    client.setConsent('maybe' as never)
    expect(client.consentState).toBe('granted')
  })
})

describe('remote config', () => {
  it('enabled:false stops sending and clears the queue', async () => {
    const { client, fake } = makeClient()
    client.capture({ type: 'track', event: 'queued_before_config' })
    fake.autoRespond = answerConfig({ enabled: false })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.queue.size).toBe(0)
    expect(client.capture({ type: 'track', event: 'after' })).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.batches).toHaveLength(0)
  })

  it('uses the cached config at once and skips fetching for 5 minutes', async () => {
    const store = new MemoryStore()
    store.set(STORAGE_KEYS.config, JSON.stringify({ fetchedAt: Date.now() - 60_000, config: { blockedEvents: ['debug_ping'] } }))
    const { client, fake } = makeClient({ store })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.calls.filter((call) => call.request.method === 'GET')).toHaveLength(0)
    expect(client.capture({ type: 'track', event: 'debug_ping' })).toBeUndefined()
    expect(client.capture({ type: 'track', event: 'other' })).toBeDefined()
  })

  it('fetches with the key and applies the session timeout', async () => {
    const { client, fake } = makeClient()
    fake.autoRespond = answerConfig({ sessionTimeoutWebMin: 1 })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    const get = fake.calls.find((call) => call.request.method === 'GET')!
    expect(get.request.url).toBe('https://ingest.test/v1/config?key=rb_pub_testkey123')
    const first = client.capture({ type: 'track', event: 'a' })!
    vi.setSystemTime(Date.now() + 61_000)
    expect(client.capture({ type: 'track', event: 'b' })!.session_id).not.toBe(first.session_id)
  })

  it('a 401 from config stops sending like a batch 401', async () => {
    const { client, fake } = makeClient()
    fake.autoRespond = answerConfig({ error: 'invalid_key' }, 401)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    client.capture({ type: 'track', event: 'a' })
    await client.flush()
    expect(client.dispatcher.stopped).toBe(true)
    expect(fake.batches).toHaveLength(0)
    expect(client.queue.size).toBe(1)
  })

  it('sampling is stable per anonymous id', async () => {
    const ids = Array.from({ length: 2000 }, () => uuidv4())
    const kept = ids.filter((id) => isSampledIn(id, 0.25))
    expect(kept.length / ids.length).toBeGreaterThan(0.2)
    expect(kept.length / ids.length).toBeLessThan(0.3)
    for (const id of ids.slice(0, 50)) expect(isSampledIn(id, 0.25)).toBe(isSampledIn(id, 0.25))
    expect(isSampledIn('anything', 1)).toBe(true)
    expect(isSampledIn('anything', 0)).toBe(false)

    const inId = ids.find((id) => fnv1a32(id) / 2 ** 32 < 0.5)!
    const outId = ids.find((id) => fnv1a32(id) / 2 ** 32 >= 0.5)!
    for (const [id, expected] of [
      [inId, true],
      [outId, false],
    ] as const) {
      const store = new MemoryStore()
      store.set(STORAGE_KEYS.anonymousId, id)
      store.set(STORAGE_KEYS.config, JSON.stringify({ fetchedAt: Date.now(), config: { sampleRate: 0.5 } }))
      const { client } = makeClient({ store })
      for (let i = 0; i < 5; i++) expect(client.capture({ type: 'track', event: 'x' }) !== undefined).toBe(expected)
    }
  })

  it('ignores malformed config values', async () => {
    const { client, fake } = makeClient()
    fake.autoRespond = answerConfig({ enabled: 'no', sampleRate: 7, sessionTimeoutWebMin: -1, blockedEvents: [1, 'x'] })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.remoteConfig).toMatchObject({ enabled: true, sampleRate: 1, sessionTimeoutWebMin: 30, blockedEvents: ['x'] })
  })
})
