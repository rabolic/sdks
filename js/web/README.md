# @rabolic/web

Rabolic product analytics for the browser. No runtime dependencies; the CDN build is under 8 KB gzip.

## Install

```bash
npm install @rabolic/web
```

```ts
import { rabolic } from '@rabolic/web'

rabolic.init({ projectKey: 'rb_pub_…', trackRoutes: true })

// after signup or login
rabolic.identify(user.id, { plan: 'pro' })

rabolic.track('signup_completed', { method: 'google' })
```

`createRabolic()` returns an independent instance if you need more than the `rabolic` singleton.
Calls made before `init` are kept (up to 100) and replayed.

### Script tag

Paste the loader into `<head>`. It defines a stub `window.rabolic` that queues calls until the
script has loaded, then replays them in order:

```html
<script>
  !(function (w, d, src) {
    if (w.rabolic) return
    var q = (w.rabolic = [])
    var m = ['init', 'track', 'page', 'identify', 'reset', 'register', 'unregister', 'setConsent', 'optOut', 'optIn', 'flush']
    for (var i = 0; i < m.length; i++)
      (function (n) {
        q[n] = function () {
          q.push([n].concat([].slice.call(arguments)))
        }
      })(m[i])
    q.getAnonymousId = function () {
      return null
    }
    q.appLink = function (url) {
      return url
    }
    var s = d.createElement('script')
    s.async = true
    s.src = src
    d.head.appendChild(s)
  })(window, document, 'https://cdn.rabolic.com/v1/rabolic.js')

  rabolic.init({ projectKey: 'rb_pub_YOUR_KEY' })
</script>
```

The same code is exported as `SNIPPET` (and `snippetFor(projectKey)`) and lives in
[`snippet/snippet.html`](snippet/snippet.html).

Without the loader, a plain tag initializes itself from its data attributes:

```html
<script async src="https://cdn.rabolic.com/v1/rabolic.js" data-key="rb_pub_…" data-host="https://ingest.example.com"></script>
```

The CDN file is `dist/rabolic.global.js` from this package.

## API

| Method | Does |
|---|---|
| `init(options)` | Starts the SDK. Logs and does nothing for a missing, invalid or secret key |
| `track(event, properties?)` | Custom event. snake_case; names starting with `$` are reserved |
| `page(properties?)` | A manual `$pageview` |
| `identify(userId, traits?)` | Sets `user_id` on this and later events; sends `$identify` with `traits` |
| `reset()` | Logout: new anonymous id and session, no user id, no super properties |
| `register(properties)` / `unregister(key)` | Super properties, sent with every later event (event properties win) |
| `setConsent('granted' \| 'pending' \| 'denied')` | Changes consent at runtime |
| `optOut()` / `optIn()` | `setConsent('denied')` / `setConsent('granted')` |
| `flush()` | Sends the queue now. Never rejects |
| `getAnonymousId()` | The anonymous id, or `null` before `init` |
| `appLink(url)` | Adds `rb_aid=<anonymous id>` to a store or deep link (needs consent). The app SDK reports it in `$deep_link`; the server stores it but doesn't link the visitor to the app user yet, so use `identify` on both sides |

No method throws into your page. Pass `debug: true` to see why a call was dropped.

## Options

| Option | Default | |
|---|---|---|
| `projectKey` | required | Publishable key, `rb_pub_…` |
| `host` | `https://ingest.rabolic.com` | For a first-party proxy or self-hosting |
| `trackRoutes` | `true` | `$pageview` on SPA navigation (`pushState`, `replaceState`, `popstate`) |
| `trackPageLeave` | `true` | `$page_leave` with `active_ms` and `scroll_depth` |
| `persistence` | `'localStorage'` | `'memory'`: cookieless, ids last one page lifetime |
| `cookieDomain` | current host | Such as `.example.com`, to share `rb_aid` across subdomains |
| `consent` | `'granted'` | `'pending'` until your cookie banner answers |
| `debug` | `false` | Log every call |
| `flushAt` | `20` | Send when this many events are queued (1–500) |
| `flushIntervalMs` | `5000` | Send at least this often |

At start the SDK fetches remote config (`GET /v1/config`, cached for 5 minutes). Today it sets the
session timeout from your project settings. The protocol also lets it turn tracking off, block
events, sample devices and switch automatic page views and page leaves off, and the SDK honors those
fields, but no project setting controls them yet.

## Automatic behaviour

- **Page views:** one `$pageview` on load and one per SPA route. Same-URL and hash-only
  changes are ignored.
- **Page leave:** one `$page_leave` per page view, on route change or the first time the page
  is hidden. `active_ms` counts time the page was visible and interacted with in the last 30 s;
  `scroll_depth` is the furthest point seen (0–1).
- **Page hide:** on `visibilitychange` to hidden or `pagehide`, queued events go out with
  `navigator.sendBeacon` as `text/plain`, with the key in the body.
- **Campaigns:** `utm_*` and the click id type (`gclid`, `fbclid`, `ttclid`, `msclkid`) from the
  landing URL go in `context.campaign`. A landing with different parameters starts a new session.
- **Sessions:** shared across tabs through `localStorage`; a new one after 30 minutes without
  events (or the project's web session timeout), and on `reset()`.
- **Context:** `platform: 'web'`, locale, time zone, screen size and density, page URL, path,
  title and referrer, and the user agent.
- **Requests:** `text/plain` with the key in the body and no credentials, so the browser sends no
  CORS preflight. The queue persists in `localStorage` (`rb_queue`, 1,000 events) and survives
  reloads.

## Privacy

- Never reads form fields, clipboard or location, and does no fingerprinting.
- The anonymous id is a random UUID in `localStorage` (`rb_aid`), mirrored to a first-party
  `rb_aid` cookie (`SameSite=Lax`, `Secure` on https, one year).
- `consent: 'pending'` writes no cookie and nothing to storage and sends nothing; events wait in
  memory until `setConsent('granted')`. `denied` drops the queue and removes everything stored,
  cookie included.
- Secret keys (`rb_live_`, `rb_test_`) are refused in the browser.
