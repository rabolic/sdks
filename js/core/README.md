# @rabolic/sdk-core

The platform-agnostic engine of the Rabolic JavaScript SDKs. `@rabolic/web` and `@rabolic/node`
bundle it; you only use it directly to build an SDK for another runtime (React Native next).
It has no runtime dependencies and needs `fetch`, `crypto.getRandomValues` and `TextEncoder`
(or injected replacements).

## What it implements

| Area | Protocol | Module |
|---|---|---|
| Ids: UUIDv4 `anonymous_id`, UUIDv7 `event_id` / `session_id`, from `crypto.getRandomValues` | §4 | `ids.ts` |
| Property limits: 255 keys per level, depth 5, keys up to 255 chars, 32 KB per event; prototype-pollution guard | §2 | `sanitize.ts` |
| Queue: ordered, max size with drop-oldest, 7-day max age, persistence through a `KeyValueStore` | §5 | `queue.ts` |
| Batches of at most 500 events or 900 KB, one request in flight, 10 s timeout | §5 | `dispatcher.ts` |
| Responses: 2xx remove the batch (rejected and dropped are final); 400 and other 4xx drop; 401 stops sending for the process and keeps the queue; 413 splits in half, then drops a single oversized event; 408, 5xx, timeouts and network errors back off `min(300 s, 1 s × 2^attempt) × random(0.5–1)`, reset after a success; 429 waits `Retry-After` | §1, §5 | `dispatcher.ts` |
| Remote config: cached copy at once, fetched in the background (skipped while the cache is under 5 minutes old), `enabled: false` clears the queue, `blockedEvents`, stable sampling on FNV-1a of `anonymous_id` | §6 | `remote-config.ts` |
| Sessions in shared storage (tabs share them), timeout from remote config, new session on new campaign parameters, `start()` for reset or app launch | §4 | `session.ts` |
| Consent: `granted`, `pending` (writes stay in memory, nothing is sent), `denied` (queue and stored state wiped) | §7 | `storage.ts`, `device-client.ts` |
| Super properties (`register` / `unregister`), identify, reset, debug logger that never sees keys | | `device-client.ts`, `logger.ts` |

## API

| Export | Purpose |
|---|---|
| `createDeviceClient(options)` | The client engine. Options: `key`, `host`, `library`, `platform`, `store`, `transport`, `logger`, `consent`, `flushAt`, `flushIntervalMs`, `maxQueueSize`, `sessionTimeoutMs(config)`, `getContext()`, `keyPlacement`, and optional `timeoutMs`, `clock`, `timers`, `randomBytes`, `random` |
| `createDispatcher(options)` / `createEventQueue(options)` | The sending pipeline on its own (the Node SDK uses these) |
| `createSessionManager`, `createRemoteConfigLoader`, `createConsentGatedStore`, `MemoryStore`, `safeStore` | Building blocks |
| `fetchTransport()`, `sendWithTimeout()` | HTTP on the global `fetch` |
| `uuidv4`, `uuidv7`, `fnv1a32`, `isSampledIn`, `sanitizeProperties`, `buildEvent` | Helpers |

Every time source is injected (`Clock`, `Timers`), so the whole pipeline runs under fake timers in tests.

## Notes

- `KeyValueStore` is synchronous. Runtimes with async storage keep a copy in memory, hydrated at
  startup, and write through in the background.
- The 5-minute config freshness is also what the HTTP cache gives browsers; the stored copy is what
  makes the first events of a page view use the last known config.
