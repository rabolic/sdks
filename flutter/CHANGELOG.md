## 0.1.2

- Accepts `device_info_plus` 11 to 13 and `package_info_plus` 8.3 to 10, so
  apps still on `package_info_plus` 8 or 9 (and `win32` 5) can add the SDK.
  CI tests both ends of the ranges.

## 0.1.1

- The package page links to the GitHub repository instead of rabolic.com,
  which has no site yet.
- First release published from GitHub Actions.

## 0.1.0

First release.

- Static `Rabolic` API and injectable `RabolicClient`: `track`, `screen`,
  `identify`, `reset`, `register` / `unregister`, `setConsent`, `optIn` /
  `optOut`, `flush`, `handleDeepLink`, `anonymousId` and `appAccountToken`.
- `RabolicNavigatorObserver` for Navigator, go_router and auto_route.
- Lifecycle events: `$app_first_open`, `$app_update`, `$app_open` and
  `$app_background`.
- Mobile and web session rules from protocol v1.
- Persisted queue: a file on iOS and Android, `localStorage` on the web.
  Batching, retry with backoff, 413 split, 401 stop and 429 `Retry-After`.
- Remote config: kill switch, session timeouts, lifecycle switch, blocked
  events and stable sampling.
- Consent states: `granted`, `pending` and `denied`.
