import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installGlobal } from '../src/install-global'
import { SNIPPET, snippetFor } from '../src/snippet'
import { fakeIngest, HOST, KEY, openPage, sentEvents, type TestPage } from './helpers'

let page: TestPage
afterEach(async () => {
  vi.useRealTimers()
  await page?.close()
})

const SNIPPET_FILE = readFileSync(new URL('../snippet/snippet.html', import.meta.url), 'utf8')

/** Runs the loader snippet's JavaScript in the page, the way a browser would run the inline script. */
function runSnippet(target: TestPage, html: string): void {
  const code = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
  // Sloppy-mode `with` resolves bare globals (`window`, `document`, `rabolic`) against the page window.
  new Function('scope', `with (scope) {${code}}`)(target.win)
}

describe('loader snippet', () => {
  it('snippet.html and the SNIPPET export are the same code', () => {
    expect(SNIPPET_FILE).toContain(SNIPPET)
    expect(snippetFor('rb_pub_abc')).toContain("rabolic.init({ projectKey: 'rb_pub_abc' })")
  })

  it('stubs window.rabolic, queues calls before load and injects the async script', () => {
    page = openPage()
    runSnippet(page, snippetFor(KEY))
    const stub = (page.win as unknown as { rabolic: unknown[] & Record<string, (...args: unknown[]) => unknown> }).rabolic
    stub.track!('signup_completed', { method: 'google' })
    stub.identify!('usr_1')
    expect(stub.getAnonymousId!()).toBeNull()
    expect(stub.appLink!('https://x.test/')).toBe('https://x.test/')
    expect([...stub]).toEqual([
      ['init', { projectKey: KEY }],
      ['track', 'signup_completed', { method: 'google' }],
      ['identify', 'usr_1'],
    ])
    const script = page.win.document.head.querySelector('script')!
    expect(script.getAttribute('src')).toBe('https://cdn.rabolic.com/v1/rabolic.js')
    expect((script as HTMLScriptElement).async).toBe(true)
  })

  it('the CDN bundle replays the queued calls in order', async () => {
    page = openPage()
    runSnippet(page, snippetFor(KEY))
    const stub = (page.win as unknown as { rabolic: Record<string, (...args: unknown[]) => unknown> }).rabolic
    stub.track!('signup_completed', { method: 'google' })
    stub.identify!('usr_1')
    const fake = fakeIngest()
    const sdk = installGlobal(page.win, { transport: fake.transport })
    expect((page.win as unknown as { rabolic: unknown }).rabolic).toBe(sdk)
    expect(sdk.getAnonymousId()).toMatch(/^[0-9a-f-]{36}$/)
    await sdk.flush()
    const events = sentEvents(fake)
    expect(events.map((event) => event.event)).toEqual(['$pageview', 'signup_completed', '$identify'])
    expect(events[2]!.user_id).toBe('usr_1')
    expect(fake.calls[0]!.request.url).toContain('https://ingest.rabolic.com/v1/config')
  })

  it('auto-initializes from data-key and data-host on the script tag', async () => {
    page = openPage()
    const script = page.win.document.createElement('script')
    script.setAttribute('data-key', KEY)
    script.setAttribute('data-host', HOST)
    Object.defineProperty(page.win.document, 'currentScript', { value: script, configurable: true })
    const fake = fakeIngest()
    const sdk = installGlobal(page.win, { transport: fake.transport })
    sdk.track('from_script_tag')
    await sdk.flush()
    expect(fake.calls[0]!.request.url).toBe(`${HOST}/v1/config?key=${KEY}`)
    expect(sentEvents(fake).map((event) => event.event)).toEqual(['$pageview', 'from_script_tag'])
  })

  it('a queued init wins over data attributes, and loading twice keeps one instance', () => {
    page = openPage()
    ;(page.win as unknown as { rabolic: unknown[] }).rabolic = [['init', { projectKey: KEY, host: HOST }], ['not_a_method'], 'junk']
    const script = page.win.document.createElement('script')
    script.setAttribute('data-key', 'rb_pub_other')
    Object.defineProperty(page.win.document, 'currentScript', { value: script, configurable: true })
    const fake = fakeIngest()
    const sdk = installGlobal(page.win, { transport: fake.transport })
    expect(fake.calls[0]!.request.url).toBe(`${HOST}/v1/config?key=${KEY}`)
    expect(installGlobal(page.win)).toBe(sdk)
  })
})
