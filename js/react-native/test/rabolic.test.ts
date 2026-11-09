import { acceptAll, assertValidBatch, FakeTransport, type SentEvent } from '@rabolic/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createRabolic, resolveOptions } from '../src'
import { FakeDevice } from './fakes/host'

const KEY = 'rb_pub_test123'
let now = Date.parse('2026-11-09T10:00:00.000Z')
const clock = { now: () => now }
const manualTimers = { setTimeout: () => 0, clearTimeout: () => {} }

function app(device: FakeDevice) {
  const fake = new FakeTransport()
  fake.autoRespond = (call) => (call.request.method === 'GET' ? call.respond(200, { enabled: true, sampleRate: 1 }) : call.respond(200, acceptAll(call)))
  const sdk = createRabolic({ host: device.host(), transport: fake.transport, clock, timers: manualTimers })
  const sent = (): SentEvent[] => fake.batches.flatMap((b) => b.events)
  return { sdk, fake, sent }
}

describe('@rabolic/react-native', () => {
  beforeEach(() => {
    now = Date.parse('2026-11-09T10:00:00.000Z')
  })

  it('first launch: $app_first_open then $app_open, a session, the device context, and valid batches', async () => {
    const device = new FakeDevice()
    const { sdk, fake, sent } = app(device)
    sdk.track('before_init') // kept until init finishes, then sent after the launch events
    await sdk.init({ projectKey: KEY, app: { version: '4.12.0', build: '412' } })
    sdk.screen('Home', { tab: 'feed' })
    await sdk.flush()

    for (const b of fake.batches) assertValidBatch(b)
    expect(sent().map((e) => e.event)).toEqual(['$app_first_open', '$app_open', 'before_init', '$screen'])
    const [first, open, , screen] = sent() as Array<Record<string, any>>
    expect(open!.properties).toEqual({ from_background: false })
    expect(first!.session_id).toBe(open!.session_id)
    expect(screen).toMatchObject({ type: 'screen', properties: { name: 'Home', tab: 'feed' }, context: { screen_name: 'Home', platform: 'ios' } })
    expect(first!.context).toMatchObject({ platform: 'ios', app: { version: '4.12.0', build: '412' }, os: { name: 'iOS', version: '18.1' }, device: { type: 'mobile', manufacturer: 'Apple' }, screen: { width: 393, height: 852, density: 3 } })
    expect(fake.batches[0]!.key).toBeUndefined() // the key goes in the header
    expect(fake.calls.find((c) => c.request.method === 'POST')!.request.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(sdk.getAnonymousId()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a relaunch keeps the anonymous id, starts a new session, and sends $app_update on a new version', async () => {
    const device = new FakeDevice()
    const one = app(device)
    await one.sdk.init({ projectKey: KEY, app: { version: '4.12.0' } })
    await one.sdk.flush()
    const firstId = one.sdk.getAnonymousId()
    const firstSession = (one.sent()[0] as Record<string, unknown>).session_id

    now += 3_600_000
    const two = app(device)
    await two.sdk.init({ projectKey: KEY, app: { version: '4.13.0' } })
    await two.sdk.flush()
    expect(two.sdk.getAnonymousId()).toBe(firstId)
    expect(two.sent().map((e) => e.event)).toEqual(['$app_update', '$app_open'])
    expect((two.sent()[0] as Record<string, any>).properties).toEqual({ previous_version: '4.12.0' })
    expect((two.sent()[0] as Record<string, unknown>).session_id).not.toBe(firstSession)
  })

  it('background and foreground: $app_background with foreground time, a new session only after 30 s away', async () => {
    const device = new FakeDevice()
    const { sdk, sent } = app(device)
    await sdk.init({ projectKey: KEY })
    const session = () => (sent().at(-1) as Record<string, unknown>).session_id

    now += 20_000
    device.set('inactive') // iOS control center: not a background
    device.set('background')
    await sdk.flush()
    expect(sent().at(-1)).toMatchObject({ event: '$app_background', properties: { foreground_ms: 20_000 } })
    const before = session()

    now += 10_000 // back within 30 s: same session
    device.set('active')
    await sdk.flush()
    expect(sent().at(-1)).toMatchObject({ event: '$app_open', properties: { from_background: true } })
    expect(session()).toBe(before)

    device.set('background')
    now += 31_000 // away for longer: a new session
    device.set('active')
    await sdk.flush()
    expect(session()).not.toBe(before)
  })

  it('a launch into the background sends $app_open only when the app is shown, as not from background', async () => {
    const device = new FakeDevice()
    device.state = 'background'
    const { sdk, sent } = app(device)
    await sdk.init({ projectKey: KEY })
    await sdk.flush()
    expect(sent().map((e) => e.event)).toEqual(['$app_first_open'])
    device.set('active')
    await sdk.flush()
    expect(sent().at(-1)).toMatchObject({ event: '$app_open', properties: { from_background: false } })
  })

  it('identify, deep links with rb_aid, React Navigation screens, and no lifecycle when turned off', async () => {
    const device = new FakeDevice()
    device.os = 'android'
    const { sdk, sent } = app(device)
    await sdk.init({ projectKey: KEY, trackLifecycle: false })
    sdk.identify('usr_1', { plan: 'pro' })
    sdk.trackDeepLink('acmefit://open?ref=mail&rb_aid=4f1c2b7e-9d0a-4e2a-8c1f-1b2c3d4e5f60')

    let listener: (() => void) | undefined
    let route = 'Home'
    const stop = sdk.trackNavigation({ isReady: () => true, getCurrentRoute: () => ({ name: route }), addListener: (_e, cb) => ((listener = cb), () => (listener = undefined)) })
    route = 'Workout'
    listener!()
    listener!() // same route again: no second $screen
    stop()
    expect(listener).toBeUndefined()
    await sdk.flush()

    expect(sent().map((e) => e.event)).toEqual(['$identify', '$deep_link', '$screen', '$screen'])
    expect(sent()[0]).toMatchObject({ user_id: 'usr_1', traits: { plan: 'pro' } })
    expect(sent()[1]).toMatchObject({ properties: { linked_anonymous_id: '4f1c2b7e-9d0a-4e2a-8c1f-1b2c3d4e5f60' } })
    expect(sent().slice(2).map((e) => (e as Record<string, any>).properties.name)).toEqual(['Home', 'Workout'])
    expect((sent()[0] as Record<string, any>).context).toMatchObject({ platform: 'android', device: { model: 'Pixel 8', manufacturer: 'Google' }, os: { name: 'Android', version: '34' } })
  })

  it('consent: denied sends nothing and stores nothing new; the queue survives a relaunch with consent', async () => {
    const device = new FakeDevice()
    const denied = app(device)
    await denied.sdk.init({ projectKey: KEY, consent: 'denied' })
    denied.sdk.track('nope')
    await denied.sdk.flush()
    expect(denied.sent()).toEqual([])

    const offline = new FakeDevice()
    const fake = new FakeTransport()
    fake.autoRespond = (call) => (call.request.method === 'GET' ? call.respond(200, {}) : call.fail())
    const first = createRabolic({ host: offline.host(), transport: fake.transport, clock, timers: manualTimers })
    await first.init({ projectKey: KEY })
    first.track('queued_offline')
    await first.flush()
    const second = app(offline)
    await second.sdk.init({ projectKey: KEY })
    await second.sdk.flush()
    expect(second.sent().map((e) => e.event)).toContain('queued_offline')
  })

  it('refuses secret keys and the web, and keeps calls from throwing', async () => {
    const warnings: unknown[][] = []
    expect(resolveOptions({ projectKey: 'rb_live_x' }, { warn: (...a) => warnings.push(a) })).toBeUndefined()
    expect(String(warnings[0]![0])).toContain('secret key refused')
    expect(resolveOptions({ projectKey: KEY, host: 'ftp://x' }, { warn: () => {} })?.host).toBe('https://ingest.rabolic.com')

    const web = new FakeDevice()
    web.os = 'web'
    const { sdk, sent } = app(web)
    await sdk.init({ projectKey: KEY })
    sdk.track('ignored')
    sdk.screen('')
    await sdk.flush()
    expect(sdk.getAnonymousId()).toBeNull()
    expect(sent()).toEqual([])
  })
})
