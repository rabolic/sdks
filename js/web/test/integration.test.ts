import { assertValidBatch, MockIngestServer } from '@rabolic/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRabolic } from '../src'
import { KEY, openPage, type TestPage } from './helpers'

/** The web SDK against a real local HTTP server, with the default fetch transport and real timers. */
describe('@rabolic/web over HTTP', () => {
  let server: MockIngestServer
  let page: TestPage

  beforeEach(async () => {
    server = new MockIngestServer()
    await server.start()
  })
  afterEach(async () => {
    await page?.close()
    await server.stop()
  })

  it('sends simple text/plain requests with the key in the body, and retries a 503', async () => {
    server.script.push({ status: 503 })
    page = openPage()
    const sdk = createRabolic({ window: page.win, random: () => 0 })
    sdk.init({ projectKey: KEY, host: server.url, flushAt: 100, flushIntervalMs: 60_000 })
    sdk.identify('usr_42', { plan: 'pro' })
    sdk.track('checkout_started', { price: 79.99 })
    await sdk.flush()
    await new Promise((resolve) => setTimeout(resolve, 700))
    await sdk.flush()

    const posts = server.requests.filter((request) => request.method === 'POST')
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      // No Authorization header and a text/plain body: a CORS "simple request", so no preflight.
      expect(post.headers['content-type']).toBe('text/plain;charset=UTF-8')
      expect(post.headers.authorization).toBeUndefined()
      assertValidBatch(post.body)
    }
    expect(server.batches[1]!.events.map((event) => event.event_id)).toEqual(server.batches[0]!.events.map((event) => event.event_id))
    expect(server.accepted.map((event) => event.event)).toEqual(['$pageview', '$identify', 'checkout_started'])
    expect(server.requests.some((request) => request.method === 'OPTIONS')).toBe(false)
  })

  it('delivers the page-hide beacon payload', async () => {
    page = openPage()
    // Stand in for the browser: POST the beacon body as text/plain, the way sendBeacon does.
    page.beacon.mockImplementation((url: string, body: string) => {
      void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
      return true
    })
    const sdk = createRabolic({ window: page.win })
    sdk.init({ projectKey: KEY, host: server.url, flushAt: 100, flushIntervalMs: 60_000 })
    sdk.track('read_article')
    page.hide()
    const deadline = Date.now() + 3000
    while (server.accepted.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.batches[0]!.key).toBe(KEY)
    expect(server.accepted.map((event) => event.event)).toEqual(['$pageview', 'read_article', '$page_leave'])
  })
})
