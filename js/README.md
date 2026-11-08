# Rabolic JavaScript SDKs

A pnpm workspace with the JavaScript SDKs for Rabolic. They implement the ingest protocol in
[`spec/protocol.md`](../spec/protocol.md), and every batch they produce is validated in tests
against [`spec/schema/batch.schema.json`](../spec/schema/batch.schema.json).

| Package | What it is | Runtime deps |
|---|---|---|
| [`@rabolic/web`](web/) | Browser SDK: npm (ESM/CJS) and a CDN script (`dist/rabolic.global.js`, 8 KB gzip budget) | none |
| [`@rabolic/node`](node/) | Server SDK: secret key, verified revenue, checkout metadata | none |
| [`@rabolic/sdk-core`](core/) | Platform-agnostic engine both are built on, and React Native will be | none |
| `test-utils/` | Private: schema validator, fake transport, protocol mock server | |

`@rabolic/web` and `@rabolic/node` bundle `sdk-core` into their builds, so installing either pulls in nothing else.

## Develop

Node 20+ and pnpm 11.

```bash
pnpm install
pnpm -r typecheck
pnpm -r test     # unit tests plus a real-HTTP integration test per package
pnpm -r build    # web also checks the CDN bundle against its size budget
```

Packages import each other from source (the `@rabolic/source` export condition and a vitest/tsdown
alias), so there is no build order to remember.

## Layout

```
core/src
  types.ts            wire types (protocol §2)
  ids.ts              UUIDv4, UUIDv7, FNV-1a (sampling), UTF-8 size
  sanitize.ts         property limits, prototype-pollution guard, name and id checks
  event.ts            event builder
  storage.ts          KeyValueStore, memory store, consent-gated store
  queue.ts            ordered queue: max size (drop oldest), 7-day max age, persistence
  transport.ts        fetch transport and the 10 s timeout
  dispatcher.ts       batching, one request in flight, every response rule of §1, backoff of §5
  remote-config.ts    /v1/config fetch, cache, parsing, sampling
  session.ts          session ids shared through storage (§4)
  device-client.ts    the client SDK engine: identity, sessions, super properties, consent, config
web/src               browser: options, storage and cookie, context, campaigns, page tracking, CDN bootstrap
node/src              server: Rabolic class, idempotency keys (UUIDv5)
```

## Adding React Native later

`createDeviceClient` takes everything platform-specific as options: a synchronous `KeyValueStore`
(wrap AsyncStorage in a copy hydrated at startup), a `Transport` (fetch works), `getContext()`,
the platform, and a session timeout. Mobile session rules (new session on launch and after
`sessionBackgroundSec` in the background) are `session.start()` calls from an `AppState` listener.
React Native has no `crypto.getRandomValues`: pass `randomBytes` (for example from `expo-crypto`).
Core also needs `TextEncoder`, which Hermes ships from RN 0.74.
