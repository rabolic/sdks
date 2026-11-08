import { acceptAll, FakeTransport, type SentBatch } from '@rabolic/test-utils'
import { Window as HappyWindow } from 'happy-dom'
import { vi } from 'vitest'
import { createRabolic, type RabolicWeb, type WebOptions } from '../src'

export const KEY = 'rb_pub_webtest123'
export const HOST = 'https://ingest.test'

export interface TestPage {
  win: Window
  happy: HappyWindow
  beacon: ReturnType<typeof vi.fn<(url: string, body: string) => boolean>>
  cookieWrites: string[]
  /** Dispatches a plain event on the window. */
  fire(type: string): void
  hide(): void
  show(): void
  close(): Promise<void>
}

/** A fresh browser page per test, with `sendBeacon` and cookie writes recorded. */
export function openPage(url = 'https://shop.example.com/pricing', referrer = 'https://google.com/'): TestPage {
  const happy = new HappyWindow({
    url,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigator: { userAgent: 'Mozilla/5.0 (TestBrowser)' } },
  })
  const win = happy as unknown as Window
  win.document.title = 'Pricing'
  Object.defineProperty(win.document, 'referrer', { value: referrer, configurable: true })
  const beacon = vi.fn<(url: string, body: string) => boolean>(() => true)
  Object.defineProperty(win.navigator, 'sendBeacon', { value: beacon, configurable: true })

  const cookieWrites: string[] = []
  const jar = new Map<string, string>()
  Object.defineProperty(win.document, 'cookie', {
    configurable: true,
    get: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (cookie: string) => {
      cookieWrites.push(cookie)
      const [pair = ''] = cookie.split(';')
      const [name = '', value = ''] = pair.split('=')
      if (/Max-Age=0/.test(cookie)) jar.delete(name)
      else jar.set(name, value)
    },
  })

  let visibility: DocumentVisibilityState = 'visible'
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => visibility })
  const setVisibility = (state: DocumentVisibilityState): void => {
    visibility = state
    win.document.dispatchEvent(new happy.Event('visibilitychange') as unknown as Event)
  }
  return {
    win,
    happy,
    beacon,
    cookieWrites,
    fire: (type) => win.dispatchEvent(new happy.Event(type) as unknown as Event),
    hide: () => setVisibility('hidden'),
    show: () => setVisibility('visible'),
    close: () => happy.happyDOM.close(),
  }
}

/** A fake ingest that answers config and accepts every batch. */
export function fakeIngest(config: unknown = { enabled: true }): FakeTransport {
  const fake = new FakeTransport()
  fake.autoRespond = (call) => {
    if (call.request.method === 'GET') call.respond(200, config)
    else call.respond(200, acceptAll(call))
  }
  return fake
}

export function startSdk(page: TestPage, options: Partial<WebOptions> = {}, fake = fakeIngest()): { sdk: RabolicWeb; fake: FakeTransport } {
  const sdk = createRabolic({ window: page.win, transport: fake.transport, random: () => 1 })
  sdk.init({ projectKey: KEY, host: HOST, flushIntervalMs: 60_000, flushAt: 100, ...options })
  return { sdk, fake }
}

/** Every event sent, through fetch and through beacons, in order. */
export function sentEvents(fake: FakeTransport, page?: TestPage): SentBatch['events'] {
  const beaconBatches = (page?.beacon.mock.calls ?? []).map(([, body]) => JSON.parse(body) as SentBatch)
  return [...fake.batches, ...beaconBatches].flatMap((batch) => batch.events)
}
