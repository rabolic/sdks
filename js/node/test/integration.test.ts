import { assertValidBatch, MockIngestServer } from '@rabolic/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventIdFor, Rabolic } from '../src'

/** The Node SDK against a real local HTTP server with the default fetch transport and real timers. */
describe('@rabolic/node over HTTP', () => {
  let server: MockIngestServer

  beforeEach(async () => {
    server = new MockIngestServer()
    await server.start()
  })
  afterEach(async () => {
    await server.stop()
  })

  it('delivers through 429 and 413, deduplicable by idempotency key, and shutdown drains', async () => {
    server.script.push(
      { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '1' } },
      { status: 413, body: { error: 'payload_too_large' } },
    )
    const rabolic = new Rabolic({ secretKey: 'rb_live_integration', host: server.url })
    await rabolic.purchase({ userId: 'usr_1', amount: 9.99, currency: 'EUR', transactionId: 'pi_9', product: 'pro' })
    await rabolic.track({ userId: 'usr_1', event: 'plan_upgraded', idempotencyKey: 'sub_1:upgrade' })
    await rabolic.flush()
    expect(server.batches).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await rabolic.shutdown()

    expect(server.batches.map((batch) => batch.events.length)).toEqual([2, 2, 1, 1])
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe('Bearer rb_live_integration')
      expect(request.headers['content-type']).toBe('application/json')
      assertValidBatch(request.body)
    }
    expect(server.accepted.map((event) => event.event_id)).toEqual([
      eventIdFor('$purchase', 'pi_9'),
      eventIdFor('plan_upgraded', 'sub_1:upgrade'),
    ])
  })

  it('stops after a 401 and keeps the events', async () => {
    server.script.push({ status: 401, body: { error: 'invalid_key' } })
    const rabolic = new Rabolic({ secretKey: 'rb_live_revoked', host: server.url })
    await rabolic.track({ userId: 'u', event: 'a' })
    await rabolic.flush()
    await rabolic.track({ userId: 'u', event: 'b' })
    await rabolic.flush()
    expect(server.batches).toHaveLength(1)
  })
})
