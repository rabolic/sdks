# @rabolic/node

Rabolic for servers: server-side events, verified revenue and checkout metadata. Node 20+ (global
`fetch`), no runtime dependencies.

## Install

```bash
npm install @rabolic/node
```

```ts
import { Rabolic } from '@rabolic/node'

const rabolic = new Rabolic({ secretKey: process.env.RABOLIC_SECRET_KEY })

await rabolic.track({
  userId: 'usr_8f2k1x9q',
  event: 'subscription_renewed',
  properties: { amount: 9.99, currency: 'USD' },
  idempotencyKey: invoice.id,
})

// before the process exits (and at the end of a serverless invocation)
await rabolic.shutdown()
```

## API

| Method | Does |
|---|---|
| `track({ event, userId?, anonymousId?, properties?, timestamp?, idempotencyKey? })` | Queues a custom event. Resolves once queued |
| `identify({ userId, anonymousId?, traits? })` | Sets person traits; with `anonymousId`, links that visitor to the user |
| `purchase` / `renewal` / `refund({ userId?, anonymousId?, amount, currency, transactionId, product, properties?, timestamp?, idempotencyKey? })` | Verified revenue: `$purchase`, `$renewal`, `$refund` with `amount`, `currency`, `transaction_id`, `product`. The idempotency key defaults to `transactionId` |
| `flush()` | Sends the queue. Respects a backoff the server asked for |
| `shutdown()` | Stops the timer and sends everything, skipping any backoff wait. Idempotent; later events are dropped |
| `checkoutMetadata({ userId?, anonymousId? })` | `{ rabolic_user_id?, rabolic_anonymous_id? }` for Dodo Payments checkout metadata, so the payment webhook links the revenue to the person. Other providers aren't supported yet. Also a standalone export |

Every event needs `userId` or `anonymousId`. With only `userId`, it is also sent as the
`anonymous_id` (the protocol requires one), so it must then be at most 128 characters; the server
treats it as a user without a device id. Calls never throw or reject; invalid ones are dropped and, with `debug: true`, logged.
The constructor does throw for a missing or wrong key: that is a deployment bug, not a tracking call.

## Options

| Option | Default | |
|---|---|---|
| `secretKey` | required | `rb_live_…` or `rb_test_…`. Publishable keys (`rb_pub_…`) are refused |
| `host` | `https://ingest.rabolic.com` | |
| `flushAt` | `20` | Send when this many events are queued (1–500) |
| `flushIntervalMs` | `10000` | Send at least this often |
| `maxQueueSize` | `10000` | Kept in memory; the oldest are dropped beyond it |
| `timeoutMs` | `10000` | Per request |
| `debug` | `false` | Log every call |

## Idempotency

`idempotencyKey` becomes the `event_id`: UUIDv5 (SHA-1) of `` `${event}\n${idempotencyKey}` `` in
the namespace `405a74de-a60c-4882-b7da-344cfaaeb42c` (exported as `EVENT_ID_NAMESPACE`, with
`eventIdFor(event, key)`). A webhook handled twice, or a retry from another process, produces the
same id, and the server drops an id it has received in the last 48 hours. The event name is part of the hash, so one invoice id can
key both a `$renewal` and a custom event.

## Delivery

Batches of up to 500 events go to `POST /v1/batch` with `Authorization: Bearer`, one request at a
time. Server errors (including `503`) and timeouts are retried with exponential backoff (up to 5
minutes), `429` waits for `Retry-After`, `413` splits the batch, and `401` stops sending and keeps
the queue. Other `4xx` responses drop the batch. Events still queued after 7 days are dropped. The
server rejects events whose `timestamp` is more than 30 days old, so don't backfill older history.
Timers are unref'd, so the SDK never keeps your process alive; call `shutdown()` to drain.

## Privacy and security

- The key is sent only in the `Authorization` header and never logged.
- Properties are copied safely (`__proto__`, `constructor` and `prototype` keys are dropped) and
  capped at 255 keys per level and depth 5. Events over 32 KB are dropped; the server rejects
  events over 32,000 characters.
- Server events carry no `context.platform`; the server assigns the person's last client platform
  from the past 24 hours, else `server`.
