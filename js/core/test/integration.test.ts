import { assertValidBatch, MockIngestServer } from '@rabolic/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceClient, fetchTransport, MemoryStore, silentLogger } from '../src'

/** Real HTTP against a local server implementing protocol §1, with real timers. */
describe('DeviceClient over HTTP', () => {
  let server: MockIngestServer

  beforeEach(async () => {
    server = new MockIngestServer()
    await server.start()
  })
  afterEach(async () => {
    await server.stop()
  })

  function client(timeoutMs = 10_000) {
    const instance = createDeviceClient({
      key: 'rb_pub_integration1',
      host: server.url,
      library: { name: 'rabolic-web', version: '0.1.0' },
      platform: 'web',
      store: new MemoryStore(),
      transport: fetchTransport(),
      logger: silentLogger,
      consent: 'granted',
      flushAt: 100,
      flushIntervalMs: 60_000,
      maxQueueSize: 1000,
      sessionTimeoutMs: (config) => config.sessionTimeoutWebMin * 60_000,
      getContext: () => ({}),
      keyPlacement: 'body',
      timeoutMs,
      random: () => 0,
    })
    instance.start()
    return instance
  }

  async function until(condition: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('timed out waiting')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('delivers schema-valid batches with the key in the body', async () => {
    const sdk = client()
    sdk.capture({ type: 'track', event: 'signup_completed', properties: { method: 'google' } })
    await sdk.flush()
    expect(server.requests.some((request) => request.method === 'GET' && request.path.startsWith('/v1/config?key='))).toBe(true)
    const [batch] = server.batches
    assertValidBatch(batch)
    expect(batch!.key).toBe('rb_pub_integration1')
    expect(server.accepted.map((event) => event.event)).toEqual(['signup_completed'])
    sdk.stop()
  })

  it('retries a 500 with the same event_id, and honours 429 Retry-After', async () => {
    server.script.push({ status: 500 }, { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '1' } })
    const sdk = client()
    const event = sdk.capture({ type: 'track', event: 'a' })!
    await sdk.flush()
    await until(() => server.accepted.length === 1, 4000)
    expect(server.batches.map((batch) => batch.events[0]?.event_id)).toEqual([event.event_id, event.event_id, event.event_id])
    sdk.stop()
  })

  it('splits on 413 and stops for good on 401', async () => {
    server.script.push({ status: 413, body: { error: 'payload_too_large' } })
    const sdk = client()
    for (let i = 0; i < 4; i++) sdk.capture({ type: 'track', event: `e${i}` })
    await sdk.flush()
    expect(server.batches.map((batch) => batch.events.length)).toEqual([4, 2, 2])

    server.script.push({ status: 401, body: { error: 'invalid_key' } })
    sdk.capture({ type: 'track', event: 'later' })
    await sdk.flush()
    sdk.capture({ type: 'track', event: 'even_later' })
    await sdk.flush()
    expect(server.batches).toHaveLength(4)
    expect(sdk.queue.size).toBe(2)
    sdk.stop()
  })

  it('times out slow requests and retries', async () => {
    server.script.push({ status: 200, delayMs: 600 })
    const sdk = client(200)
    sdk.capture({ type: 'track', event: 'slow' })
    await sdk.flush()
    expect(sdk.dispatcher.waitingToRetry).toBe(true)
    await until(() => server.batches.length === 2 && sdk.queue.size === 0, 4000)
    sdk.stop()
  })
})
