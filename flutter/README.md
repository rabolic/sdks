# rabolic_flutter

Product analytics for Flutter apps, from [Rabolic](https://rabolic.com).

- One pure-Dart SDK for **iOS, Android and Flutter web**. No platform
  channels of its own.
- Events survive restarts and offline periods in a persisted queue. They are
  sent in batches with retry and backoff.
- Sessions, app lifecycle events, screen tracking for Navigator, go_router
  and auto_route, deep-link attribution and in-app-purchase linking.
- Consent states, no advertising ids and no fingerprinting.

## Install

```sh
flutter pub add rabolic_flutter
```

The SDK needs Dart 3.10 and Flutter 3.38 or later.

## Quick start

```dart
import 'package:rabolic_flutter/rabolic_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Rabolic.init(const RabolicConfig(projectKey: 'rb_pub_…'));
  runApp(const MyApp());
}

// Anywhere in the app:
Rabolic.track('workout_started', properties: {'program_id': 'strength-30'});
```

You don't have to await `init`. Calls made while the SDK is loading are kept,
with their original timestamps, and sent once it has loaded.

To track screens, add the observer:

```dart
MaterialApp(
  navigatorObservers: [RabolicNavigatorObserver()],
  // …
);
```

Turn on `debug: true` while you integrate. Every call and response is
logged, and events appear in the dashboard's live events within seconds.

## API

All calls are static on `Rabolic`. None of them throws into your app: invalid
input is logged (with `debug: true`) and ignored.

| Call | What it does |
|---|---|
| `Rabolic.init(RabolicConfig)` | Starts the SDK. Call once. A second call is ignored |
| `Rabolic.track(name, {properties})` | Sends a custom event. Use `snake_case`, 1–200 characters. Names may not start with `$` |
| `Rabolic.screen(name, {properties})` | Sends `$screen`, with the name in `context.screen_name` and `properties.name` |
| `Rabolic.identify(userId, {traits})` | Sets `user_id` on this and every later event, and sends `$identify` with `traits` |
| `Rabolic.reset()` | Logout. Creates a new anonymous id and session, and clears the user id, super properties and `appAccountToken` |
| `Rabolic.register(props)` / `Rabolic.unregister(key)` | Super properties, added to every event and kept across launches. Event properties win over them |
| `Rabolic.setConsent(RabolicConsent)` | Changes consent at runtime (see [Privacy](#privacy)) |
| `Rabolic.optOut()` / `Rabolic.optIn()` | Short for `setConsent(denied)` / `setConsent(granted)` |
| `Rabolic.flush()` | Sends queued events now |
| `Rabolic.handleDeepLink(Uri)` | Sends `$deep_link` (see [Deep links](#deep-links)) |
| `Rabolic.anonymousId` | This install's anonymous id (UUIDv4), or `null` until `init` completes |
| `Rabolic.appAccountToken` | A stable UUID for the identified person, for in-app purchases |
| `Rabolic.close()` | Stops the SDK, mostly for tests |

Property values may be strings, numbers, booleans, `null`, lists and maps.
`DateTime` values are sent as RFC 3339 strings, enums as their name and
`Uri`s as strings. Any other value is dropped.

### Testing and dependency injection

`RabolicClient` is the instance behind the static calls. Create one yourself
to inject an `http.Client`, or to pass analytics into code under test:

```dart
final client = RabolicClient(config, httpClient: myClient);
await client.ready;
client.track('signed_up');
```

To route the static calls to it, use `Rabolic.instance = client` (marked
`@visibleForTesting`).

## Configuration

```dart
RabolicConfig(
  projectKey: 'rb_pub_…',           // required: the publishable key
  host: 'https://ingest.rabolic.com', // or your first-party proxy
  flushAt: 20,                      // send when this many events are queued
  flushInterval: Duration(seconds: 15), // default: 15 s on mobile, 5 s on web
  maxQueueSize: 10000,              // default: 10,000 on mobile, 1,000 on web
  trackLifecycle: true,             // $app_* events (iOS and Android)
  consent: RabolicConsent.granted,  // starting consent state
  debug: false,                     // log every call
)
```

The project's settings in Rabolic are fetched from `GET /v1/config` at start.
They are cached on the device and refreshed when the app returns to the
foreground and the cache is more than 5 minutes old. Tracking never waits for
them. These settings can:
- turn the project off (`enabled: false` stops sending and clears the queue);
- change the session timeouts;
- turn lifecycle events off;
- block event names;
- sample devices (`sampleRate`). Sampling is stable per device.

### Automatic events

On iOS and Android, with `trackLifecycle: true`:

| Event | When | Properties |
|---|---|---|
| `$app_first_open` | First launch after install | |
| `$app_update` | First launch on a new app version | `previous_version` |
| `$app_open` | Launch, and every return to the foreground | `from_background` |
| `$app_background` | The app leaves the foreground | `foreground_ms` |

A launch straight into the background (a push or background fetch) sends
`$app_open` only when the app is first shown. Queued events are sent when the
app goes to the background.

### Sessions

- **iOS and Android:** a session starts at launch, and again when the app
  returns after more than 30 seconds in the background. The project setting
  can change the 30 seconds. Time in the background never counts as active
  time.
- **Web:** a session starts after 30 minutes without an event, or when the
  page is opened with campaign parameters that differ from the current
  session's. Tabs share the session.
- `reset()` always starts a new session.

## go_router

Pass the observer to `GoRouter`. Screens are named after the route's `name`,
or its path pattern (`/users/:id`) when it has none:

```dart
final router = GoRouter(
  observers: [RabolicNavigatorObserver()],
  routes: [
    GoRoute(path: '/', name: 'home', builder: (_, __) => const HomeScreen()),
    GoRoute(path: '/users/:id', builder: (_, state) => UserScreen(state.pathParameters['id']!)),
  ],
);
```

A `ShellRoute` or `StatefulShellBranch` has its own navigator, so give it its
own observer: `ShellRoute(observers: [RabolicNavigatorObserver()], …)`. A
`NavigatorObserver` can only watch one navigator at a time, so don't reuse
one instance.

### auto_route

```dart
MaterialApp.router(
  routerConfig: _appRouter.config(
    navigatorObservers: () => [RabolicNavigatorObserver()],
  ),
);
```

Screens are named after the route name (`HomeRoute`). Tab changes inside
`AutoTabsRouter` don't go through a navigator. Call `Rabolic.screen` for
those yourself.

### Naming and filtering screens

By default the observer tracks only `PageRoute`s, so dialogs, sheets and
menus don't count, and it uses `RouteSettings.name`. Both are configurable:

```dart
RabolicNavigatorObserver(
  nameExtractor: (settings) => settings.name?.replaceFirst('/', ''),
  routeFilter: (route) => route is PageRoute && route.settings.name != '/splash',
);
```

Routes without a name are skipped. Use `MaterialPageRoute(settings:
RouteSettings(name: 'Checkout'), …)` or named routes.

## In-app purchases

`Rabolic.appAccountToken` is a stable UUID for the identified person. Pass it
to `in_app_purchase` as `applicationUserName`:

```dart
final purchase = PurchaseParam(
  productDetails: product,
  applicationUserName: Rabolic.appAccountToken,
);
await InAppPurchase.instance.buyNonConsumable(purchaseParam: purchase);
```

The App Store returns it as `appAccountToken` and Google Play as
`obfuscatedAccountId`. Rabolic reads it from the store's transaction data and
uses it to link verified purchases to the person.

- The token is created by `identify`.
- It is kept across launches.
- It changes when a different user is identified.
- `reset()` clears it.
- It is `null` until someone is identified, so call `identify` before the
  purchase.
- It is also sent as the `app_account_token` trait on `$identify`, which is
  how Rabolic knows whose token it is.

## Deep links

Call `Rabolic.handleDeepLink` with every link that opens the app. With
[`app_links`](https://pub.dev/packages/app_links):

```dart
AppLinks().uriLinkStream.listen(Rabolic.handleDeepLink);
```

The SDK sends `$deep_link` with:
- `url`;
- `linked_anonymous_id`, from the link's `rb_aid` parameter. The web SDK's
  `appLink()` adds it, and Rabolic uses it to join the web visitor to the app
  user;
- `context.campaign`, from `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `utm_term` and the click ids (`gclid`, `fbclid`, `ttclid`,
  `msclkid`).

The full URL is sent. If your links can carry secrets, such as magic-link
login tokens, strip them before you pass the `Uri`.

## Privacy

The SDK never collects:
- advertising ids (IDFA, GAID);
- the Android id;
- form field values;
- the clipboard;
- location;
- device fingerprints.

The device context is limited to:
- platform;
- app version, build and bundle id;
- device model, manufacturer and type;
- OS name and version;
- locale and time zone;
- screen size and density.

On the web, it also sends the user agent. The anonymous id is a random UUID
created on the device.

### Consent

| State | Behaviour |
|---|---|
| `granted` (default) | Tracks and sends normally |
| `pending` | Keeps new events in memory only (never on disk) and sends nothing. Switching to `granted` sends them; `denied` drops them |
| `denied` | Drops every event and clears the queue on disk |

Pass the starting state as `RabolicConfig.consent`. A state you set at
runtime (`setConsent`, `optIn`, `optOut`) is stored on the device and wins
over `RabolicConfig.consent` on later launches.

### iOS privacy manifest

The SDK has no native code, so it has no `PrivacyInfo.xcprivacy` of its own.
The plugins it uses (`shared_preferences`, `path_provider`,
`package_info_plus` and `device_info_plus`) ship their own manifests,
including the `UserDefaults` required-reason API (CA92.1). In your app's
`PrivacyInfo.xcprivacy`, declare the data Rabolic collects for you:
- **Product Interaction:** analytics, not used for tracking.
- **Device ID:** the install's anonymous id. Analytics, not used for tracking.
- **User ID:** only if you call `identify`. Analytics, linked to the user,
  not used for tracking.

Rabolic doesn't track across apps and websites owned by other companies in
Apple's sense. `NSPrivacyTracking` stays `false`, and App Tracking
Transparency isn't needed.

### Google Play Data safety

Declare:
- **App activity → App interactions:** collected, for analytics.
- **Device or other IDs:** the anonymous install id, for analytics.
- **Personal info → User IDs:** only if you call `identify`.

Data is encrypted in transit (HTTPS). Rabolic processes it as your service
provider, which Play doesn't count as sharing. Users can ask you to delete
their data; delete the person in Rabolic.

## Limits

| Limit | Value |
|---|---|
| Event name | 1–200 characters |
| Properties | 255 keys per level, nesting depth 5, keys up to 255 characters |
| Serialized event | 32 KB. Larger events are dropped |
| User id | 1–255 characters |
| Queue | 10,000 events on iOS and Android, 1,000 on the web. When it is full, the oldest events are dropped |
| Event age | Events older than 7 days are dropped before sending |
| Batch | 500 events or 900 KB. Bodies over 1 KB are gzipped (not on the web) |
| Requests | One at a time, 10 s timeout. Backoff from 1 s to 5 min with jitter. `Retry-After` is honored |

Known limitations:
- **Desktop** (macOS, Windows, Linux) isn't supported yet. There, every call
  does nothing, and debug builds log one line saying so.
- **Time zone:** on iOS and Android, Dart only exposes abbreviations such as
  `CET`, which are ambiguous, so `context.timezone` is left out there. The web
  sends the IANA name.
- **Web page close:** browsers may cancel a request when the tab closes.
  Unsent events stay in `localStorage` and go out on the next visit.
- **Android Auto Backup** restores `shared_preferences` on reinstall, so a
  restored install keeps its anonymous id and doesn't send
  `$app_first_open`.
- **One client per process:** the queue file is shared, so don't run two
  `RabolicClient`s at once in an app.
