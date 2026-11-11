import { assertValidBatch, type SentBatch } from '@rabolic/test-utils'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRabolic, VERSION } from '../src'
import { fakeIngest, HOST, KEY, openPage, sentEvents, startSdk, type TestPage } from './helpers'

let page: TestPage

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await page?.close()
})

describe('init and $pageview', () => {
  it('sends a schema-valid $pageview with web context, campaign and the key in a text/plain body', async () => {
    page = openPage('https://shop.example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=q4&gclid=abc123')
    const { sdk, fake } = startSdk(page)
    await sdk.flush()
    const post = fake.calls.find((call) => call.request.method === 'POST')!
    expect(post.request.url).toBe(`${HOST}/v1/batch`)
    expect(post.request.headers).toEqual({ 'Content-Type': 'text/plain;charset=UTF-8' })
    const batch = post.body as SentBatch
    assertValidBatch(batch)
    expect(batch.key).toBe(KEY)
    expect(batch.library).toEqual({ name: 'rabolic-web', version: VERSION })
    const [pageview] = batch.events as Array<Record<string, any>>
    expect(pageview).toMatchObject({ type: 'page', event: '$pageview', anonymous_id: sdk.getAnonymousId() })
    expect(pageview!.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(pageview!.context).toMatchObject({
      platform: 'web',
      locale: expect.any(String),
      timezone: expect.any(String),
      user_agent: 'Mozilla/5.0 (TestBrowser)',
      page: {
        url: 'https://shop.example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=q4&gclid=abc123',
        path: '/pricing',
        title: 'Pricing',
        referrer: 'https://google.com/',
      },
      campaign: { source: 'google', medium: 'cpc', name: 'q4', click_id: 'gclid' },
    })
    expect(fake.calls[0]?.request.url).toBe(`${HOST}/v1/config?key=${KEY}`)
  })

  it('refuses secret keys and bad options without throwing', () => {
    page = openPage()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeIngest()
    const sdk = createRabolic({ window: page.win, transport: fake.transport })
    expect(() => sdk.init({ projectKey: 'rb_live_secret' })).not.toThrow()
    expect(() => sdk.init(undefined as never)).not.toThrow()
    expect(() => sdk.init({ projectKey: 42 } as never)).not.toThrow()
    expect(warn.mock.calls.some(([, message]) => String(message).includes('secret key refused'))).toBe(true)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('rb_live_secret')
    expect(sdk.getAnonymousId()).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  it('tracking calls never throw, whatever they are given', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => {
      sdk.track(undefined as never)
      sdk.track('$purchase', { amount: 1 })
      sdk.track('ok_event', loop)
      sdk.identify(undefined as never)
      sdk.register('nope' as never)
      sdk.unregister(7 as never)
      sdk.setConsent('maybe' as never)
      sdk.page(null as never)
    }).not.toThrow()
    await sdk.flush()
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['$pageview', 'ok_event', '$pageview'])
  })

  it('replays calls made before init', async () => {
    page = openPage()
    const fake = fakeIngest()
    const sdk = createRabolic({ window: page.win, transport: fake.transport })
    sdk.track('early_event', { n: 1 })
    sdk.identify('usr_early')
    sdk.init({ projectKey: KEY, host: HOST })
    await sdk.flush()
    expect(sentEvents(fake).map((event) => [event.event, event.user_id])).toEqual([
      ['$pageview', undefined],
      ['early_event', undefined],
      ['$identify', 'usr_early'],
    ])
  })

  it('skips $pageview when remote config turns page views off', async () => {
    page = openPage()
    page.win.localStorage.setItem(
      'rb_config',
      JSON.stringify({ fetchedAt: Date.now(), config: { autocapture: { pageviews: false } } }),
    )
    const { sdk, fake } = startSdk(page)
    sdk.track('still_tracked')
    await sdk.flush()
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['still_tracked'])
  })

  it('exports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})

describe('SPA navigation', () => {
  it('sends $page_leave for the old route and $pageview for the new one, with the in-app referrer', async () => {
    page = openPage('https://shop.example.com/a')
    const { sdk, fake } = startSdk(page)
    vi.advanceTimersByTime(4000)
    page.win.history.pushState({}, '', '/b?x=1')
    await sdk.flush()
    const events = sentEvents(fake) as Array<Record<string, any>>
    expect(events.map((event) => event.event)).toEqual(['$pageview', '$page_leave', '$pageview'])
    expect(events[1]!.context.page.path).toBe('/a')
    expect(events[1]!.properties.active_ms).toBe(4000)
    expect(events[2]!.context.page).toMatchObject({ path: '/b', referrer: 'https://shop.example.com/a' })
    for (const batch of fake.batches) assertValidBatch(batch)
  })

  it('dedupes same-URL and hash-only changes, and follows popstate', async () => {
    page = openPage('https://shop.example.com/a')
    const { sdk, fake } = startSdk(page)
    page.win.history.replaceState({}, '', '/a')
    page.win.history.pushState({}, '', '/a#section')
    page.win.history.pushState({}, '', '/b')
    page.happy.happyDOM.setURL('https://shop.example.com/a')
    page.fire('popstate')
    await sdk.flush()
    expect(sentEvents(fake).filter((event) => event.event === '$pageview').map((event) => (event.context as any).page.path)).toEqual([
      '/a',
      '/b',
      '/a',
    ])
  })

  it('trackRoutes: false sends only the initial $pageview', async () => {
    page = openPage('https://shop.example.com/a')
    const { sdk, fake } = startSdk(page, { trackRoutes: false })
    page.win.history.pushState({}, '', '/b')
    await sdk.flush()
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['$pageview'])
  })
})

describe('$page_leave and sendBeacon', () => {
  it('on hide, sends queued events and $page_leave by beacon as text/plain with the key in the body', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    sdk.track('clicked_cta')
    page.hide()
    expect(page.beacon).toHaveBeenCalledTimes(1)
    const [url, body] = page.beacon.mock.calls[0]!
    expect(url).toBe(`${HOST}/v1/batch`)
    expect(typeof body).toBe('string') // sendBeacon sends a string as text/plain;charset=UTF-8
    const batch = JSON.parse(body) as SentBatch
    assertValidBatch(batch)
    expect(batch.key).toBe(KEY)
    expect(batch.events.map((event) => event.event)).toEqual(['$pageview', 'clicked_cta', '$page_leave'])
    await sdk.flush()
    expect(fake.batches).toHaveLength(0)

    page.show()
    page.hide()
    expect(page.beacon).toHaveBeenCalledTimes(1)
  })

  it('measures active time: visible and interacted with in the last 30 s', () => {
    page = openPage()
    startSdk(page)
    vi.advanceTimersByTime(10_000)
    page.fire('pointerdown')
    vi.advanceTimersByTime(60_000) // idle: only 30 s of it counts
    page.fire('keydown')
    vi.advanceTimersByTime(5_000)
    page.hide()
    const leave = sentEvents(fakeIngest(), page).find((event) => event.event === '$page_leave') as Record<string, any>
    expect(leave.properties.active_ms).toBe(10_000 + 30_000 + 5_000)
  })

  it('does not count time while the page is hidden (background tab)', async () => {
    page = openPage('https://shop.example.com/a')
    page.hide()
    const { sdk, fake } = startSdk(page)
    vi.advanceTimersByTime(20_000)
    page.show()
    vi.advanceTimersByTime(4_000)
    page.win.history.pushState({}, '', '/b')
    await sdk.flush()
    const leave = sentEvents(fake).find((event) => event.event === '$page_leave') as Record<string, any>
    expect(leave.properties.active_ms).toBe(4_000)
  })

  it('reports the furthest scroll depth', () => {
    page = openPage()
    Object.defineProperty(page.win.document.documentElement, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(page.win, 'innerHeight', { value: 500, configurable: true })
    startSdk(page)
    Object.defineProperty(page.win, 'scrollY', { value: 1000, configurable: true })
    page.fire('scroll')
    Object.defineProperty(page.win, 'scrollY', { value: 200, configurable: true })
    page.hide()
    const leave = sentEvents(fakeIngest(), page).find((event) => event.event === '$page_leave') as Record<string, any>
    expect(leave.properties.scroll_depth).toBe(0.75)
  })

  it('trackPageLeave: false still flushes by beacon on hide, without $page_leave', () => {
    page = openPage()
    startSdk(page, { trackPageLeave: false })
    page.hide()
    expect(sentEvents(fakeIngest(), page).map((event) => event.event)).toEqual(['$pageview'])
  })
})

describe('anonymous id, cookie and storage', () => {
  it('persists the id in localStorage and mirrors it to a first-party cookie', () => {
    page = openPage()
    const { sdk } = startSdk(page, { cookieDomain: '.example.com' })
    const id = sdk.getAnonymousId()!
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/)
    expect(page.win.localStorage.getItem('rb_aid')).toBe(id)
    const cookie = page.cookieWrites.find((write) => write.startsWith('rb_aid='))!
    expect(cookie).toBe(`rb_aid=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.example.com; Secure`)
  })

  it('leaves out Secure on http pages', () => {
    page = openPage('http://localhost:3000/')
    startSdk(page)
    expect(page.cookieWrites.find((write) => write.startsWith('rb_aid='))).not.toContain('Secure')
  })

  it('restores the id from the cookie when localStorage was cleared, and ignores malformed cookies', () => {
    page = openPage()
    page.win.document.cookie = 'rb_aid=0b5e9d1c-5d7e-4b0a-9a51-3f2c1d4e5f60'
    expect(startSdk(page).sdk.getAnonymousId()).toBe('0b5e9d1c-5d7e-4b0a-9a51-3f2c1d4e5f60')
    void page.close()

    page = openPage()
    page.win.document.cookie = 'rb_aid=<script>'
    expect(startSdk(page).sdk.getAnonymousId()).not.toBe('<script>')
  })

  it("persistence: 'memory' writes no cookie and nothing to localStorage", async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page, { persistence: 'memory' })
    sdk.track('a')
    sdk.register({ plan: 'pro' })
    expect(page.win.localStorage.length).toBe(0)
    expect(page.cookieWrites).toHaveLength(0)
    expect(sdk.getAnonymousId()).toBeTruthy()
    // The server counts the visitor per day and starts sessions: events say so and carry no session id.
    await sdk.flush()
    const events = sentEvents(fake) as Array<Record<string, any>>
    expect(events.map((event) => [event.event, event.context.cookieless, event.session_id])).toEqual([
      ['$pageview', true, undefined],
      ['a', true, undefined],
    ])
    for (const batch of fake.batches) assertValidBatch(batch)
  })

  it('marks nothing cookieless with the default persistence', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    sdk.track('a')
    await sdk.flush()
    const events = sentEvents(fake) as Array<Record<string, any>>
    expect(events.every((event) => event.context.cookieless === undefined && typeof event.session_id === 'string')).toBe(true)
  })

  it('falls back to memory when localStorage throws', async () => {
    page = openPage()
    vi.spyOn(page.win.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { sdk, fake } = startSdk(page)
    sdk.track('still_works')
    await sdk.flush()
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['$pageview', 'still_works'])
  })
})

describe('consent', () => {
  it('pending: no cookie, no storage, no requests; granted: persists and sends', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page, { consent: 'pending' })
    sdk.track('before_consent')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.batches).toHaveLength(0)
    expect(page.cookieWrites).toHaveLength(0)
    expect(page.win.localStorage.getItem('rb_aid')).toBeNull()
    page.hide()
    expect(page.beacon).not.toHaveBeenCalled()

    sdk.setConsent('granted')
    await vi.advanceTimersByTimeAsync(0)
    expect(page.win.localStorage.getItem('rb_aid')).toBe(sdk.getAnonymousId())
    expect(page.cookieWrites.some((write) => write.startsWith(`rb_aid=${sdk.getAnonymousId()}`))).toBe(true)
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['$pageview', 'before_consent', '$page_leave'])
  })

  it('optOut clears the queue, storage and cookie; optIn resumes with a new id', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    const before = sdk.getAnonymousId()
    sdk.track('queued')
    sdk.optOut()
    expect(page.win.localStorage.getItem('rb_queue')).toBeNull()
    expect(page.win.localStorage.getItem('rb_aid')).toBeNull()
    expect(page.cookieWrites.at(-1)).toContain('Max-Age=0')
    sdk.track('while_denied')
    await sdk.flush()
    expect(fake.batches).toHaveLength(0)

    sdk.optIn()
    sdk.track('after_opt_in')
    await sdk.flush()
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['after_opt_in'])
    expect(sdk.getAnonymousId()).not.toBe(before)
  })
})

describe('sessions', () => {
  it('tabs share an anonymous id and a session through localStorage', async () => {
    page = openPage()
    const first = startSdk(page)
    vi.advanceTimersByTime(60_000)
    const second = startSdk(page)
    first.sdk.track('tab_one')
    second.sdk.track('tab_two')
    await Promise.all([first.sdk.flush(), second.sdk.flush()])
    const one = sentEvents(first.fake).find((event) => event.event === 'tab_one')!
    const two = sentEvents(second.fake).find((event) => event.event === 'tab_two')!
    expect(two.anonymous_id).toBe(one.anonymous_id)
    expect(two.session_id).toBe(one.session_id)
  })

  it('a landing with different campaign parameters starts a new session; the same ones keep it', async () => {
    page = openPage('https://shop.example.com/?utm_source=google')
    const first = startSdk(page)
    await first.sdk.flush()
    const firstSession = first.fake.batches[0]!.events[0]!.session_id

    page.happy.happyDOM.setURL('https://shop.example.com/?utm_source=google')
    const same = startSdk(page)
    await same.sdk.flush()
    expect(same.fake.batches[0]!.events[0]!.session_id).toBe(firstSession)

    page.happy.happyDOM.setURL('https://shop.example.com/?utm_source=newsletter')
    const other = startSdk(page)
    await other.sdk.flush()
    expect(other.fake.batches[0]!.events[0]!.session_id).not.toBe(firstSession)
  })

  it('expires after 30 minutes without events', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    sdk.track('a')
    vi.setSystemTime(Date.now() + 31 * 60_000)
    sdk.track('b')
    await sdk.flush()
    const [, a, b] = sentEvents(fake)
    expect(a!.session_id).not.toBe(b!.session_id)
  })

  it('reset gives a new anonymous id and session, and drops the user id', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    sdk.identify('usr_1', { plan: 'pro' })
    const id = sdk.getAnonymousId()
    sdk.reset()
    sdk.track('after_reset')
    await sdk.flush()
    const events = sentEvents(fake)
    const identify = events.find((event) => event.event === '$identify')!
    const after = events.find((event) => event.event === 'after_reset')!
    expect(identify.user_id).toBe('usr_1')
    expect(after.user_id).toBeUndefined()
    expect(after.anonymous_id).not.toBe(id)
    expect(after.session_id).not.toBe(identify.session_id)
    expect(page.win.localStorage.getItem('rb_aid')).toBe(sdk.getAnonymousId())
  })
})

describe('super properties', () => {
  it('register and unregister', async () => {
    page = openPage()
    const { sdk, fake } = startSdk(page)
    sdk.register({ plan: 'pro', app: 'web' })
    sdk.unregister('app')
    sdk.track('x', { extra: 1, plan: 'override' })
    await sdk.flush()
    expect(sentEvents(fake).find((event) => event.event === 'x')!.properties).toEqual({ plan: 'override', extra: 1 })
  })
})

describe('appLink', () => {
  it('adds rb_aid to store and deep links', () => {
    page = openPage()
    const { sdk } = startSdk(page)
    const id = sdk.getAnonymousId()!
    expect(sdk.appLink('https://apps.apple.com/app/id123?pt=1')).toBe(`https://apps.apple.com/app/id123?pt=1&rb_aid=${id}`)
    expect(sdk.appLink('myapp://open/workout?id=7')).toBe(`myapp://open/workout?id=7&rb_aid=${id}`)
    expect(sdk.appLink('/relative')).toBe(`https://shop.example.com/relative?rb_aid=${id}`)
  })

  it('returns the URL unchanged without consent, before init, or when it is not a URL', () => {
    page = openPage()
    expect(createRabolic({ window: page.win }).appLink('https://x.test/')).toBe('https://x.test/')
    const { sdk } = startSdk(page, { consent: 'pending' })
    expect(sdk.appLink('https://x.test/')).toBe('https://x.test/')
    sdk.setConsent('granted')
    expect(sdk.appLink('http://[bad')).toBe('http://[bad')
  })
})
