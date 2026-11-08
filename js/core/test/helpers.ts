import { FakeTransport } from '@rabolic/test-utils'
import {
  buildEvent,
  createDeviceClient,
  createDispatcher,
  createEventQueue,
  MemoryStore,
  silentLogger,
  systemClock,
  systemTimers,
  uuidv7,
  type DeviceClientOptions,
  type Logger,
  type WireEvent,
} from '../src'

export function makeEvent(name = 'test_event', properties?: Record<string, string | number>): WireEvent {
  const now = Date.now()
  return buildEvent({
    eventId: uuidv7(now),
    type: 'track',
    event: name,
    timestampMs: now,
    anonymousId: 'anon-1',
    sessionId: uuidv7(now),
    properties,
    context: { platform: 'web' },
  })
}

export interface RecordingLogger extends Logger {
  debugs: string[]
  warns: string[]
}

export function recordingLogger(): RecordingLogger {
  const debugs: string[] = []
  const warns: string[] = []
  return {
    debugs,
    warns,
    debug: (message) => debugs.push(message),
    warn: (message) => warns.push(message),
  }
}

export function makeDispatcher(options: { random?: () => number; maxSize?: number; logger?: Logger } = {}) {
  const fake = new FakeTransport()
  const logger = options.logger ?? silentLogger
  const queue = createEventQueue({ maxSize: options.maxSize ?? 1000, logger })
  const dispatcher = createDispatcher({
    queue,
    transport: fake.transport,
    clock: systemClock,
    timers: systemTimers,
    random: options.random ?? (() => 1),
    logger,
    batchUrl: 'https://ingest.test/v1/batch',
    library: { name: 'rabolic-web', version: '0.1.0' },
    key: 'rb_pub_testkey123',
    keyPlacement: 'body',
  })
  const enqueue = (count: number, name = 'test_event'): WireEvent[] => {
    const events: WireEvent[] = []
    for (let i = 0; i < count; i++) {
      const event = makeEvent(name, { i })
      queue.enqueue(event, Date.now())
      events.push(event)
    }
    return events
  }
  return { fake, queue, dispatcher, enqueue }
}

export const TEST_KEY = 'rb_pub_testkey123'

export function makeClient(overrides: Partial<DeviceClientOptions> = {}) {
  const fake = new FakeTransport()
  const store = overrides.store ?? new MemoryStore()
  const client = createDeviceClient({
    key: TEST_KEY,
    host: 'https://ingest.test',
    library: { name: 'rabolic-web', version: '0.1.0' },
    platform: 'web',
    store,
    transport: fake.transport,
    logger: silentLogger,
    consent: 'granted',
    flushAt: 20,
    flushIntervalMs: 5000,
    maxQueueSize: 1000,
    sessionTimeoutMs: (config) => config.sessionTimeoutWebMin * 60_000,
    getContext: () => ({ locale: 'en-US' }),
    keyPlacement: 'body',
    random: () => 1,
    ...overrides,
  })
  return { client, fake, store }
}
