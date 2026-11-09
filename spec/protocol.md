# Rabolic ingest protocol, v1

Every Rabolic SDK implements this document, and the ingest service enforces
it. `schema/batch.schema.json` is the machine-readable form of §2; the ingest
service validates against that file, so the two can't drift.

## 1. Endpoints

Default host: `https://ingest.rabolic.com`. Every SDK lets you override it
with a `host` option, for first-party proxies and self-hosting.

| Method and path | Purpose |
|---|---|
| `POST /v1/batch` | Send 1–500 events |
| `GET /v1/config?key=<publishable key>` | Remote config (§6). Cacheable for 5 minutes |

### Authentication

| Key | Prefix | Where it may be used |
|---|---|---|
| Publishable | `rb_pub_` | Browsers and apps. Write-only. Can't send revenue events |
| Secret, production | `rb_live_` | Servers only (Node SDK, HTTP API) |
| Secret, test | `rb_test_` | Servers only |

The key's environment (production, staging or development) is stored with the
key. Events take it from the key; SDKs don't send it.

How to send the key:
- **Header (preferred):** `Authorization: Bearer <key>`.
- **Body:** the envelope's `key` field. For `navigator.sendBeacon`, which can't
  set headers. When both are present, they must be equal.

### Request

- **Content type:** `application/json` or `text/plain;charset=UTF-8`. Browsers
  use `text/plain` so the request needs no CORS preflight. The body is JSON
  either way. Any other content type gets a `415`.
- **Compression:** `Content-Encoding: gzip` is optional. Any encoding other
  than `gzip` or `identity` gets a `415`.
- **Size limits:** at most 1 MB on the wire and 5 MB decompressed, with 1–500
  events per batch.

### Responses

Every status `POST /v1/batch` can return:

| Status | Body | When | What the SDK does |
|---|---|---|---|
| `200` | `{ "accepted": n, "rejected": [{ "index": i, "reason": "…" }], "dropped": n }` | The batch was read. Some events may still be rejected or dropped | Remove the whole batch from the queue. Rejected and dropped events are final; with `debug` on, log the reasons |
| `400` | `{ "error": "invalid_batch", "message": "…" }` | The body isn't JSON, a gzip body is corrupt, or the envelope fails the schema | Drop the batch, log it, don't retry |
| `401` | `{ "error": "invalid_key" }` | The key is missing, unknown or revoked, or the header and body keys differ | Stop sending for the rest of the process lifetime and keep the queue. Log once |
| `403` | `{ "error": "origin_not_allowed" }` | The key is limited to certain origins and the request's `Origin` isn't one of them. Requests without `Origin` (apps, servers) are never refused this way | Drop the batch, log it, don't retry |
| `413` | `{ "error": "payload_too_large" }` | Over 1 MB on the wire or 5 MB decompressed | Split the batch in half and retry each half. A single event that is still too large is dropped |
| `415` | `{ "error": "invalid_batch", "message": "…" }` | Unsupported `Content-Type` or `Content-Encoding` | Drop the batch, log it, don't retry |
| `429` | `{ "error": "rate_limited" }` with `Retry-After: 60` | Too many requests per minute from one key and client IP | Retry after `Retry-After` seconds (backoff if the header is missing) |
| `503` | `{ "error": "unavailable" }` with `Retry-After: 5` | The server couldn't store the batch. None of its events were accepted | Retry with backoff (§5). Event ids make the retry safe |
| Other `5xx`, timeout or network error | varies | | Retry with backoff (§5) |
| `408` | varies | A proxy timed out | Retry with backoff, like a timeout |
| Any other `4xx` | varies | Such as a `404` from a wrong `host` | Drop the batch, log it, don't retry |

The SDKs don't read `Retry-After` on a `503` yet; their backoff starts at
0.5–1 s.

Origin allowlists are stored per key and enforced by ingest, but they can't be
set from the API or the dashboard yet, so no key has one today.

`dropped` counts events over the project's monthly cap or the organization's
plan or trial allowance. SDKs never retry them.

Rejection reasons in `rejected` (stable strings):

| Reason | Meaning |
|---|---|
| `invalid_event` | The event fails the schema (`schema/batch.schema.json#/$defs/event`) |
| `reserved_name` | A `$` name that isn't in §3 |
| `revenue_needs_secret_key` | `$purchase`, `$renewal` or `$refund` sent with a publishable key |
| `too_old` | The event is more than 30 days old, after clock correction (§2) |
| `too_large` | The serialized event is larger than 32 KB (32,768 bytes of UTF-8 JSON) |
| `blocked_event` | Reserved. The server doesn't return it yet |

## 2. Batch envelope

```json
{
  "key": "rb_pub_…",
  "sent_at": "2026-11-08T10:00:03.120Z",
  "library": { "name": "rabolic-web", "version": "0.1.0" },
  "events": [ { "…": "event, below" } ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `sent_at` | RFC 3339 UTC timestamp with milliseconds | yes | Set when the request is sent, not when the batch was built. Used for clock-skew correction |
| `library.name` | string | yes | One of `rabolic-web`, `rabolic-node`, `rabolic-react-native`, `rabolic-ios`, `rabolic-android`, `rabolic-flutter`, `http` |
| `library.version` | string | yes | The SDK's SemVer |
| `key` | string | no | See §1 |
| `events` | array, 1–500 | yes | |

### Event

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | UUID (v7 preferred) | yes | Generated once when the event is created and **kept on every retry**. The server drops an event whose id it has received in the last 48 hours |
| `type` | `track` \| `page` \| `screen` \| `identify` | yes | |
| `event` | string, 1–200 chars | yes | See §3. `page` is always `$pageview`, `screen` is always `$screen`, `identify` is always `$identify` |
| `timestamp` | RFC 3339 UTC with milliseconds | yes | When the event happened, on the device clock |
| `anonymous_id` | string, 1–128 chars | yes, on every event | See §4. Server SDKs with only a user id send it here too |
| `user_id` | string, 1–255 chars, or `null` | no | Set after `identify()`, cleared by `reset()` |
| `session_id` | UUIDv7 | client SDKs: yes; server: no | See §4 |
| `properties` | object | no | At most 255 keys per level, depth at most 5, keys at most 255 chars. Values are strings, numbers, booleans, null, arrays or objects |
| `traits` | object | no | `identify` only: person properties to set |
| `context` | object | no | Below |

The serialized event may be at most 32 KB: 32,768 bytes of the event's JSON
encoded as UTF-8, counted in bytes, not characters. SDKs drop larger events
before sending; the server rejects them with `too_large`.

The server removes these property and trait keys without rejecting the event:
- keys longer than 255 characters;
- `__proto__`, `constructor` and `prototype`;
- objects nested deeper than 5 levels;
- sensitive names: `password`, `passwd`, `pwd`, `card_number`, `cc_number`,
  `cvv`, `cvc`, `iban`, `ssn`, `social_security_number` (any case, `_`
  optional in `card_number` and `cc_number`);
- the project's blocked properties (project settings).

### Timestamps and clock correction

- **Device clocks:** when `sent_at` differs from the server's arrival time by
  more than 30 s, every event in the batch moves by that difference.
- **Future times:** an event still more than 60 s in the future after that is
  set to the arrival time.
- **Old events:** an event more than 30 days old after correction is rejected
  with `too_old`. SDKs already drop events older than 7 days before sending
  (§5).

`context` (every field optional):

```json
{
  "platform": "web | ios | android",
  "app": { "version": "4.12.0", "build": "412", "bundle": "com.acme.fit" },
  "device": { "type": "mobile | tablet | desktop | tv", "model": "iPhone15,2", "manufacturer": "Apple" },
  "os": { "name": "iOS", "version": "18.1" },
  "browser": { "name": "Chrome", "version": "131" },
  "locale": "en-US",
  "timezone": "Europe/Berlin",
  "screen": { "width": 393, "height": 852, "density": 3 },
  "page": { "url": "https://…", "path": "/pricing", "title": "Pricing", "referrer": "https://google.com/" },
  "campaign": { "source": "google", "medium": "cpc", "name": "q4", "content": "ad1", "term": "fitness", "click_id": "gclid" },
  "screen_name": "HomeScreen",
  "user_agent": "Mozilla/5.0 …"
}
```

- `context.platform` is required for client SDKs.
- Server SDKs leave it out. The server then uses the person's last client
  platform from the past 24 hours, else `server`.
- Web SDKs don't need to send `browser` or `os`: the server parses
  `user_agent`, or the request's `User-Agent` header when it is missing.

## 3. Event names

Custom event names:
- are `snake_case` by convention;
- may not start with `$`;
- may not contain control characters.

Reserved names (`$`-prefixed) the server accepts:

| Name | Type | Sent by | Properties |
|---|---|---|---|
| `$pageview` | `page` | web, automatic | (page is in `context.page`) |
| `$page_leave` | `track` | web, automatic | `active_ms`, `scroll_depth` (0–1) |
| `$screen` | `screen` | mobile, manual or helper | `screen_name` in `context.screen_name`, also as `properties.name` |
| `$identify` | `identify` | `identify()` | `traits` |
| `$app_first_open` | `track` | mobile, first launch after install | None today. `install_source` and `deferred_link` are reserved for later SDK versions; no SDK sends them yet |
| `$app_open` | `track` | mobile, each launch or foreground | `from_background` (bool) |
| `$app_background` | `track` | mobile | `foreground_ms` |
| `$app_update` | `track` | mobile, first launch on a new app version | `previous_version` |
| `$deep_link` | `track` | mobile | `url`, `linked_anonymous_id` (from the `rb_aid` link parameter) |
| `$purchase`, `$renewal`, `$refund` | `track` | **secret key only** | `amount`, `currency`, `transaction_id`, `product` |

Any other `$` name is rejected with `reserved_name`.

## 4. Ids and sessions

**`anonymous_id`**
- A UUIDv4, generated on first use and persisted:
  - web: `localStorage` key `rb_aid`, mirrored to a first-party cookie `rb_aid`;
  - apps: local storage.
- `reset()` replaces it.
- Every event carries one; the schema requires it. Server SDKs send the
  anonymous id the caller provides. When the caller gives only a user id,
  they send it as both `user_id` and `anonymous_id`.
- When `anonymous_id` equals `user_id`, the server treats the event as having
  no device id: it attaches the event to that user and links no anonymous id.

**`event_id`:** UUIDv7, generated when the event is created.

**`session_id`:** UUIDv7, generated when a session starts. Its embedded
timestamp is the session start. Every event in the session carries it.

Session rules:
- **Web:**
  - A new session starts when the last event was more than
    `sessionTimeoutWebMin` minutes ago (default 30).
  - A new session also starts when a page loads with campaign parameters
    (`utm_*`, `gclid`, `fbclid`, `ttclid`, `msclkid`) that differ from the
    current session's.
  - The session id and last-activity time live in `localStorage`, so tabs
    share a session.
- **Mobile:**
  - A new session starts on launch.
  - A new session also starts on return to the foreground after more than
    `sessionBackgroundSec` seconds in the background (default 30).
  - Background time never counts as active time.
- **`reset()`:** starts a new session.

## 5. Queue, batching and retry

| Rule | Value |
|---|---|
| Flush when queue reaches | `flushAt` events (default 20) |
| Flush every | `flushIntervalMs` (web 5,000; mobile 15,000; server 10,000) |
| Also flush | web: on `pagehide` or `visibilitychange` to hidden, with `sendBeacon`. Mobile: on background. Server: `flush()` and `shutdown()` |
| Max batch | 500 events or 900 KB serialized, whichever comes first |
| Max queue | web 1,000; mobile 10,000; server 10,000. When full, drop the **oldest** |
| Persistence | Web: `localStorage` (`rb_queue`), memory if unavailable. Mobile: a file. Server: memory |
| Max age | Events older than 7 days are dropped before sending. The server rejects events older than 30 days (§2) |
| Backoff | `min(300 s, 1 s × 2^attempt) × random(0.5–1.0)`, reset after any 200 |
| One request at a time | An SDK never has two batch requests in flight |
| Ordering | Events are sent in the order they were created |
| Timeout | 10 s per request |

## 6. Remote config

`GET /v1/config?key=rb_pub_…` returns, with `Cache-Control: public,
max-age=300`:

```json
{
  "enabled": true,
  "sessionTimeoutWebMin": 30,
  "sessionBackgroundSec": 30,
  "autocapture": { "pageviews": true, "pageLeave": true, "lifecycle": true, "screens": false },
  "blockedEvents": [],
  "sampleRate": 1
}
```

What the server sends today:
- `sessionTimeoutWebMin` (5–240) and `sessionBackgroundSec` (5–1,800) come
  from the project's settings.
- Every other field is fixed at the values above. They are part of the
  protocol and the SDKs honor them as described below, but no project setting
  changes them yet. No SDK reads `autocapture.screens`.

The key must be publishable. An unknown, revoked or secret key gets
`401 { "error": "invalid_key" }`.

How SDKs use it:
- Fetch at init; the web SDK skips this while its cached copy is under 5
  minutes old. Mobile SDKs also refetch on return to the foreground once
  their copy is over 5 minutes old. Use cached values (or the defaults above) until it arrives; never
  block tracking on it.
- `enabled: false` stops sending, and the queue is cleared.
- Names in `blockedEvents` are dropped before they are queued.
- `autocapture` switches the SDK's automatic events off: `pageviews` and
  `pageLeave` on the web, `lifecycle` on mobile.
- `sampleRate < 1` keeps the device when `hash(anonymous_id) / 2^32` is below
  the rate; the decision is stable per device. `hash` is 32-bit FNV-1a over
  the UTF-8 bytes of the anonymous id (offset basis `0x811c9dc5`, prime
  `0x01000193`), so every SDK samples the same devices.
- A `401` from config has the same meaning as for batch.

## 7. Privacy

SDKs never collect:
- advertising ids (IDFA, GAID);
- form field values;
- clipboard contents;
- device fingerprints;
- precise location.

Consent:
- `consent: 'granted'` (default) works normally.
- `consent: 'pending'` keeps events in memory only and sends nothing.
- `consent: 'denied'` drops everything and clears the queue.
- `setConsent()` changes the state at runtime.
- Web only: `persistence: 'memory'` (cookieless mode) keeps ids in memory
  only, for one page lifetime.

The server doesn't store IP addresses with events. It uses them for geo
lookup, the project's internal-traffic ranges and per-IP rate limits (a
counter that expires within 90 seconds), then drops them. Events sent with a
secret key get no geo lookup.

## 8. Linking web to app

`appLink(url)` (web) adds `rb_aid=<anonymous_id>` to a store or deep link URL.

When an app opens from a link that carries `rb_aid`, the mobile SDK sends
`$deep_link` with `linked_anonymous_id`. The server stores it with the event
but doesn't link the two anonymous people yet. Today the way to join web and
app is `identify()` with the same `user_id` on both sides.

## 9. Changes

v1 only gets additive changes: new optional fields and new reserved names.
The server accepts every SDK version released in the last 24 months.
