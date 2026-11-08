import { acceptAll, assertValidBatch, FakeTransport } from '@rabolic/test-utils'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkoutMetadata, EVENT_ID_NAMESPACE, eventIdFor, Rabolic, VERSION, type RabolicOptions } from '../src'

const SECRET = 'rb_test_secret123'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function client(options: Partial<RabolicOptions> = {}) {
  const fake = new FakeTransport()
  fake.autoRespond = (call) => call.respond(200, acceptAll(call))
  const rabolic = new Rabolic(
    { secretKey: SECRET, host: 'https://ingest.test', ...options },
    { transport: fake.transport, timers: { setTimeout, clearTimeout }, random: () => 1 },
  )
  return { rabolic, fake }
}

describe('keys', () => {
  it('rejects publishable keys with a clear error that does not echo the key', () => {
    expect(() => new Rabolic({ secretKey: 'rb_pub_abc123' })).toThrow(/needs a secret key .*not a publishable key/)
    try {
      new Rabolic({ secretKey: 'rb_pub_abc123' })
    } catch (error) {
      expect(String(error)).not.toContain('abc123')
    }
  })

  it('requires a secret key and accepts rb_live_ and rb_test_', () => {
    expect(() => new Rabolic({ secretKey: undefined })).toThrow(/secretKey is required/)
    expect(() => new Rabolic({ secretKey: 'sk_live_x' })).toThrow(/rb_live_ or rb_test_/)
    expect(() => new Rabolic({ secretKey: 'rb_live_abc' })).not.toThrow()
    expect(() => new Rabolic({ secretKey: 'rb_test_abc', host: 'ftp://nope' })).toThrow(/host/)
  })

  it('sends the key as a Bearer header with application/json, never in the body', async () => {
    const { rabolic, fake } = client()
    await rabolic.track({ userId: 'usr_1', event: 'signup_completed' })
    await rabolic.flush()
    const [call] = fake.calls
    expect(call!.request.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` })
    expect((call!.body as { key?: string }).key).toBeUndefined()
  })
})

describe('events', () => {
  it('builds schema-valid server events: no platform, library rabolic-node, user id doubling as anonymous id', async () => {
    const { rabolic, fake } = client()
    await rabolic.track({
      userId: 'usr_8f2k1x9q',
      event: 'subscription_renewed',
      properties: { amount: 9.99, currency: 'USD' },
      idempotencyKey: 'in_123',
      timestamp: new Date('2026-11-08T09:59:00.000Z'),
    })
    await rabolic.identify({ userId: 'usr_8f2k1x9q', anonymousId: 'anon-web-1', traits: { plan: 'pro' } })
    await rabolic.track({ anonymousId: 'anon-only', event: 'visited_pricing' })
    await rabolic.flush()
    const [batch] = fake.batches
    assertValidBatch(batch)
    expect(batch!.library).toEqual({ name: 'rabolic-node', version: VERSION })
    const [renewed, identify, anon] = batch!.events as Array<Record<string, any>>
    expect(renewed).toMatchObject({
      type: 'track',
      event: 'subscription_renewed',
      user_id: 'usr_8f2k1x9q',
      anonymous_id: 'usr_8f2k1x9q',
      timestamp: '2026-11-08T09:59:00.000Z',
      properties: { amount: 9.99, currency: 'USD' },
    })
    expect(renewed!.context).toBeUndefined()
    expect(renewed!.session_id).toBeUndefined()
    expect(identify).toMatchObject({ type: 'identify', event: '$identify', anonymous_id: 'anon-web-1', traits: { plan: 'pro' } })
    expect(anon!.user_id).toBeUndefined()
  })

  it('drops invalid calls without throwing or rejecting', async () => {
    const { rabolic, fake } = client({ debug: true })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(rabolic.track({ event: 'no_ids' })).resolves.toBeUndefined()
    await rabolic.track({ userId: 'u', event: '$pageview' })
    await rabolic.track({ userId: 'u', event: '' })
    await rabolic.track(undefined as never)
    await rabolic.track({ userId: 'u'.repeat(256), event: 'too_long_id' })
    await rabolic.track({ userId: 'u', event: 'bad_time', timestamp: 'yesterday' })
    await rabolic.track({ userId: 'u', event: 'bad_key', idempotencyKey: '' })
    await rabolic.track({ userId: 'u', event: 'huge', properties: { blob: 'x'.repeat(40_000) } })
    await rabolic.identify({ userId: '' })
    await rabolic.purchase({ userId: 'u', amount: Number.NaN, currency: 'USD', transactionId: 't', product: 'p' })
    await rabolic.purchase({ userId: 'u', amount: 1, currency: 'dollars', transactionId: 't', product: 'p' })
    await rabolic.flush()
    expect(fake.batches).toHaveLength(0)
    expect(log.mock.calls.filter(([, message]) => String(message).includes('dropped'))).toHaveLength(11)
    expect(log.mock.calls.flat().join(' ')).not.toContain(SECRET)
  })

  it('guards against prototype pollution in properties', async () => {
    const { rabolic, fake } = client()
    await rabolic.track({ userId: 'u', event: 'hostile', properties: JSON.parse('{"__proto__":{"polluted":1},"ok":true}') })
    await rabolic.flush()
    expect(fake.batches[0]!.events[0]!.properties).toEqual({ ok: true })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('idempotency', () => {
  it('maps idempotencyKey to a stable UUIDv5 event_id', async () => {
    const id = eventIdFor('subscription_renewed', 'in_123')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(eventIdFor('subscription_renewed', 'in_123')).toBe(id)
    expect(eventIdFor('invoice_paid', 'in_123')).not.toBe(id)
    expect(eventIdFor('subscription_renewed', 'in_124')).not.toBe(id)
    // Reference value, matching Python's uuid.uuid5(EVENT_ID_NAMESPACE, 'subscription_renewed\nin_123').
    expect(EVENT_ID_NAMESPACE).toBe('405a74de-a60c-4882-b7da-344cfaaeb42c')
    expect(id).toBe('efb589c1-cafe-504a-af92-52def4927d86')

    const first = client()
    const second = client()
    await first.rabolic.track({ userId: 'u', event: 'subscription_renewed', idempotencyKey: 'in_123' })
    await second.rabolic.track({ userId: 'u', event: 'subscription_renewed', idempotencyKey: 'in_123' })
    await Promise.all([first.rabolic.flush(), second.rabolic.flush()])
    expect(first.fake.batches[0]!.events[0]!.event_id).toBe(id)
    expect(second.fake.batches[0]!.events[0]!.event_id).toBe(id)
  })

  it('without a key, every event gets a fresh UUIDv7', async () => {
    const { rabolic, fake } = client()
    await rabolic.track({ userId: 'u', event: 'a' })
    await rabolic.track({ userId: 'u', event: 'a' })
    await rabolic.flush()
    const [a, b] = fake.batches[0]!.events
    expect(a!.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(a!.event_id).not.toBe(b!.event_id)
  })
})

describe('revenue helpers', () => {
  it('send $purchase, $renewal and $refund with the revenue fields, deduped on the transaction id', async () => {
    const { rabolic, fake } = client()
    const base = { userId: 'usr_1', currency: 'usd', product: 'pro_annual' }
    await rabolic.purchase({ ...base, amount: 79.99, transactionId: 'pi_1', properties: { coupon: 'BF', amount: 0 } })
    await rabolic.renewal({ ...base, amount: 79.99, transactionId: 'in_2' })
    await rabolic.refund({ ...base, amount: 79.99, transactionId: 'pi_1' })
    await rabolic.flush()
    const events = fake.batches[0]!.events as Array<Record<string, any>>
    assertValidBatch(fake.batches[0])
    expect(events.map((event) => event.event)).toEqual(['$purchase', '$renewal', '$refund'])
    expect(events[0]!.properties).toEqual({ coupon: 'BF', amount: 79.99, currency: 'USD', transaction_id: 'pi_1', product: 'pro_annual' })
    expect(events[0]!.event_id).toBe(eventIdFor('$purchase', 'pi_1'))
    expect(events[2]!.event_id).toBe(eventIdFor('$refund', 'pi_1'))
  })
})

describe('checkoutMetadata', () => {
  it('returns only the ids that are set', () => {
    const { rabolic } = client()
    expect(rabolic.checkoutMetadata({ userId: 'usr_1', anonymousId: 'anon_1' })).toEqual({
      rabolic_user_id: 'usr_1',
      rabolic_anonymous_id: 'anon_1',
    })
    expect(checkoutMetadata({ anonymousId: 'anon_1' })).toEqual({ rabolic_anonymous_id: 'anon_1' })
    expect(checkoutMetadata({ userId: '' })).toEqual({})
  })
})

describe('flushing and shutdown', () => {
  it('flushes at flushAt and on the interval', async () => {
    const { rabolic, fake } = client({ flushAt: 2, flushIntervalMs: 10_000 })
    await rabolic.track({ userId: 'u', event: 'a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.batches).toHaveLength(0)
    await rabolic.track({ userId: 'u', event: 'b' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.batches).toHaveLength(1)
    await rabolic.track({ userId: 'u', event: 'c' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.batches).toHaveLength(2)
  })

  it('shutdown flushes everything, skips backoff, is idempotent and drops later events', async () => {
    const { rabolic, fake } = client()
    fake.autoRespond = (call) => call.respond(503)
    await rabolic.track({ userId: 'u', event: 'a' })
    await rabolic.flush()
    expect(fake.calls).toHaveLength(1)
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    const first = rabolic.shutdown()
    expect(rabolic.shutdown()).toBe(first)
    await first
    expect(fake.calls).toHaveLength(2)
    await rabolic.track({ userId: 'u', event: 'after' })
    await rabolic.flush()
    expect(fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls).toHaveLength(2)
  })

  it('shutdown warns about events it could not deliver', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rabolic, fake } = client()
    fake.autoRespond = (call) => call.respond(500)
    await rabolic.track({ userId: 'u', event: 'a' })
    await rabolic.shutdown()
    expect(warn.mock.calls.some(([, message]) => String(message).includes('1 event(s) could not be delivered'))).toBe(true)
  })

  it('keeps at most maxQueueSize events, dropping the oldest', async () => {
    const { rabolic, fake } = client({ maxQueueSize: 3, flushAt: 500 })
    for (let i = 0; i < 5; i++) await rabolic.track({ userId: 'u', event: `e${i}` })
    await rabolic.flush()
    expect(fake.batches[0]!.events.map((event) => event.event)).toEqual(['e2', 'e3', 'e4'])
  })

  it('exports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
