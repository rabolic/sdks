import { acceptAll, assertValidBatch } from '@rabolic/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { MAX_EVENT_AGE_MS, parseRetryAfter } from '../src'
import { makeDispatcher, makeEvent, recordingLogger } from './helpers'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('200', () => {
  it('removes the whole batch, including rejected and dropped events, and logs reasons in debug', async () => {
    const logger = recordingLogger()
    const { fake, queue, dispatcher, enqueue } = makeDispatcher({ logger })
    enqueue(3)
    const flushing = dispatcher.flush()
    fake.respondNext(200, { accepted: 1, rejected: [{ index: 1, reason: 'reserved_name' }], dropped: 1 })
    await flushing
    expect(queue.size).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(logger.debugs.some((line) => line.includes('rejected: reserved_name'))).toBe(true)
    expect(logger.debugs.some((line) => line.includes('1 dropped: monthly cap'))).toBe(true)
  })

  it('treats any 2xx as success', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    const flushing = dispatcher.flush()
    fake.respondNext(204)
    await flushing
    expect(queue.size).toBe(0)
    expect(dispatcher.waitingToRetry).toBe(false)
  })

  it('still removes the batch when the body is not JSON', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(2)
    const flushing = dispatcher.flush()
    fake.respondNext(200, 'ok')
    await flushing
    expect(queue.size).toBe(0)
  })

  it('stamps sent_at at send time and sends a schema-valid envelope with the key in the body', async () => {
    const { fake, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    vi.setSystemTime(new Date('2026-11-08T10:00:07.250Z'))
    const flushing = dispatcher.flush()
    const [call] = fake.calls
    expect(call?.request.headers['Content-Type']).toBe('text/plain;charset=UTF-8')
    expect(call?.request.headers.Authorization).toBeUndefined()
    const body = call?.body as { sent_at: string; key: string }
    expect(body.sent_at).toBe('2026-11-08T10:00:07.250Z')
    expect(body.key).toBe('rb_pub_testkey123')
    assertValidBatch(body)
    fake.respondNext(200, acceptAll(call!))
    await flushing
  })
})

describe('400', () => {
  it('drops the batch, logs it and does not retry', async () => {
    const logger = recordingLogger()
    const { fake, queue, dispatcher, enqueue } = makeDispatcher({ logger })
    enqueue(2)
    const flushing = dispatcher.flush()
    fake.respondNext(400, { error: 'invalid_batch', message: 'bad' })
    await flushing
    expect(queue.size).toBe(0)
    expect(logger.warns).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fake.calls).toHaveLength(1)
  })

  it('drops on other 4xx too', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    const flushing = dispatcher.flush()
    fake.respondNext(403, { error: 'forbidden' })
    await flushing
    expect(queue.size).toBe(0)
  })
})

describe('401', () => {
  it('stops sending for the process lifetime, keeps the queue and logs once', async () => {
    const logger = recordingLogger()
    const { fake, queue, dispatcher, enqueue } = makeDispatcher({ logger })
    enqueue(2)
    const flushing = dispatcher.flush()
    fake.respondNext(401, { error: 'invalid_key' })
    await flushing
    expect(dispatcher.stopped).toBe(true)
    expect(queue.size).toBe(2)

    enqueue(1)
    await dispatcher.flush()
    await dispatcher.flush({ force: true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fake.calls).toHaveLength(1)
    expect(queue.size).toBe(3)
    dispatcher.stopForUnauthorized()
    expect(logger.warns).toHaveLength(1)
  })
})

describe('413', () => {
  it('splits the batch in half and retries each half, in order', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    const events = enqueue(5)
    fake.autoRespond = (call) => {
      const size = (call.body as { events: unknown[] }).events.length
      if (size === 5) call.respond(413, { error: 'payload_too_large' })
      else call.respond(200, acceptAll(call))
    }
    await dispatcher.flush()
    const sizes = fake.batches.map((batch) => batch.events.length)
    expect(sizes).toEqual([5, 3, 2])
    expect(fake.batches.slice(1).flatMap((batch) => batch.events.map((event) => event.event_id))).toEqual(
      events.map((event) => event.event_id),
    )
    expect(queue.size).toBe(0)
  })

  it('drops a single event that is still too large and carries on', async () => {
    const logger = recordingLogger()
    const { fake, queue, dispatcher, enqueue } = makeDispatcher({ logger })
    const [big, small] = [...enqueue(1, 'big_event'), ...enqueue(1, 'small_event')]
    fake.autoRespond = (call) => {
      const names = (call.body as { events: Array<{ event: string }> }).events.map((event) => event.event)
      if (names.includes('big_event')) call.respond(413, { error: 'payload_too_large' })
      else call.respond(200, acceptAll(call))
    }
    await dispatcher.flush()
    expect(fake.batches.map((batch) => batch.events.map((event) => event.event_id))).toEqual([
      [big!.event_id, small!.event_id],
      [big!.event_id],
      [small!.event_id],
    ])
    expect(queue.size).toBe(0)
    expect(logger.warns.some((line) => line.includes('too large'))).toBe(true)
  })
})

describe('429', () => {
  it('waits for Retry-After before retrying', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    const flushing = dispatcher.flush()
    fake.respondNext(429, { error: 'rate_limited' }, '30')
    await flushing
    expect(dispatcher.waitingToRetry).toBe(true)

    await dispatcher.flush()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fake.calls).toHaveLength(1)
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.calls).toHaveLength(2)
    expect(queue.size).toBe(0)
  })

  it('parses Retry-After seconds and ignores anything else', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter(' 0 ')).toBe(0)
    expect(parseRetryAfter('Sun, 08 Nov 2026 10:00:10 GMT')).toBeUndefined()
    expect(parseRetryAfter('-1')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })

  it('falls back to backoff when Retry-After is missing', async () => {
    const { fake, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    const flushing = dispatcher.flush()
    fake.respondNext(429)
    await flushing
    await vi.advanceTimersByTimeAsync(999)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.calls).toHaveLength(2)
  })
})

describe('5xx, timeout and network errors', () => {
  it('backs off min(300 s, 1 s × 2^attempt) × jitter and resets after a 200', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher({ random: () => 1 })
    enqueue(1)
    fake.autoRespond = (call) => call.respond(503)
    await dispatcher.flush()

    const retryTimes: number[] = []
    let last = Date.now()
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = fake.calls.length
      while (fake.calls.length === before) await vi.advanceTimersByTimeAsync(250)
      retryTimes.push(Date.now() - last)
      last = Date.now()
    }
    // random() = 1 gives the full delay. Advancing in 250 ms steps rounds up to the next step.
    expect(retryTimes).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000])

    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(queue.size).toBe(0)

    enqueue(1)
    fake.autoRespond = (call) => call.respond(500)
    await dispatcher.flush()
    const before = fake.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.calls.length).toBe(before + 1)
  })

  it('retries a 408 like a timeout instead of dropping it', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    const flushing = dispatcher.flush()
    fake.respondNext(408)
    await flushing
    expect(queue.size).toBe(1)
    expect(dispatcher.waitingToRetry).toBe(true)
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await vi.advanceTimersByTimeAsync(1000)
    expect(queue.size).toBe(0)
  })

  it('applies jitter between 0.5 and 1.0', async () => {
    const { fake, dispatcher, enqueue } = makeDispatcher({ random: () => 0 })
    enqueue(1)
    fake.autoRespond = (call) => call.fail(new Error('ECONNRESET'))
    await dispatcher.flush()
    await vi.advanceTimersByTimeAsync(499)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.calls).toHaveLength(2)
  })

  it('times out a request after 10 s and retries with backoff, keeping the event_id', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    const [event] = enqueue(1)
    const flushing = dispatcher.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await flushing
    expect(dispatcher.waitingToRetry).toBe(true)
    expect(queue.size).toBe(1)
    expect((fake.calls[0]?.request.signal as { aborted: boolean }).aborted).toBe(true)

    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.batches[1]?.events[0]?.event_id).toBe(event!.event_id)
    expect(queue.size).toBe(0)
  })

  it('a forced flush skips the backoff wait', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(1)
    fake.autoRespond = (call) => call.respond(502)
    await dispatcher.flush()
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await dispatcher.flush()
    expect(fake.calls).toHaveLength(1)
    await dispatcher.flush({ force: true })
    expect(fake.calls).toHaveLength(2)
    expect(queue.size).toBe(0)
  })
})

describe('one request in flight, in order', () => {
  it('never has two batch requests in flight and sends events in creation order', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    const first = enqueue(600)
    const flushes = [dispatcher.flush(), dispatcher.flush(), dispatcher.flush()]
    expect(fake.pending).toHaveLength(1)
    const second = enqueue(10)
    fake.respondNext(200, acceptAll(fake.calls[0]!))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.pending).toHaveLength(1)
    fake.respondNext(200, acceptAll(fake.calls[1]!))
    await Promise.all(flushes)
    expect(fake.maxConcurrent).toBe(1)
    expect(fake.batches.map((batch) => batch.events.length)).toEqual([500, 110])
    expect(fake.batches.flatMap((batch) => batch.events.map((event) => event.event_id))).toEqual(
      [...first, ...second].map((event) => event.event_id),
    )
    expect(queue.size).toBe(0)
  })

  it('keeps batches under 900 KB', async () => {
    const { fake, queue, dispatcher } = makeDispatcher()
    const padding = 'x'.repeat(10_000)
    for (let i = 0; i < 120; i++) queue.enqueue(makeEvent('big', { padding }), Date.now())
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await dispatcher.flush()
    for (const call of fake.calls) expect(Buffer.byteLength(call.request.body!)).toBeLessThan(900 * 1024)
    expect(fake.batches.length).toBeGreaterThan(1)
    expect(queue.size).toBe(0)
  })
})

describe('max age', () => {
  it('drops events older than 7 days before sending', async () => {
    const { fake, queue, dispatcher } = makeDispatcher()
    queue.enqueue(makeEvent('stale'), Date.now() - MAX_EVENT_AGE_MS - 1)
    queue.enqueue(makeEvent('fresh'), Date.now() - MAX_EVENT_AGE_MS + 1000)
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))
    await dispatcher.flush()
    expect(fake.batches[0]?.events.map((event) => event.event)).toEqual(['fresh'])
  })
})

describe('sendUnreliably (beacon)', () => {
  it('sends queued events not in flight and removes them when accepted', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    const [inFlight] = enqueue(1)
    void dispatcher.flush()
    const later = enqueue(2)
    const bodies: string[] = []
    dispatcher.sendUnreliably((body) => {
      bodies.push(body)
      return true
    }, 60_000)
    const sent = JSON.parse(bodies[0]!) as { key: string; events: Array<{ event_id: string }> }
    expect(sent.key).toBe('rb_pub_testkey123')
    expect(sent.events.map((event) => event.event_id)).toEqual(later.map((event) => event.event_id))
    expect(sent.events.some((event) => event.event_id === inFlight!.event_id)).toBe(false)
    expect(queue.size).toBe(1)
    fake.respondNext(200, acceptAll(fake.calls[0]!))
  })

  it('keeps events when the beacon is refused, and skips while backing off', async () => {
    const { fake, queue, dispatcher, enqueue } = makeDispatcher()
    enqueue(2)
    dispatcher.sendUnreliably(() => false, 60_000)
    expect(queue.size).toBe(2)

    fake.autoRespond = (call) => call.respond(500)
    await dispatcher.flush()
    const send = vi.fn(() => true)
    dispatcher.sendUnreliably(send, 60_000)
    expect(send).not.toHaveBeenCalled()
  })
})
