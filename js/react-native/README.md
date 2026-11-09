# @rabolic/react-native

Rabolic product analytics for React Native apps on iOS and Android, Expo included: app installs,
opens and updates, sessions, screens, identity and deep links. No native code of its own; events
are kept in AsyncStorage until they are sent.

## Install

The quickest way is `npx rabolic init` in your app's folder. By hand:

```bash
npx expo install @rabolic/react-native @react-native-async-storage/async-storage   # Expo
npm install @rabolic/react-native @react-native-async-storage/async-storage && cd ios && pod install   # bare React Native
```

```ts
import { rabolic } from '@rabolic/react-native'

// Once, at app start. You don't have to await it: calls made before it finishes are kept.
void rabolic.init({ projectKey: 'rb_pub_…', app: { version: '4.12.0', build: '412' } })

// after signup or login, on every platform with the same id
rabolic.identify(user.id, { plan: 'pro' })

rabolic.track('workout_started', { program_id: 'strength-30' })
```

Use the project's **publishable** key (`rb_pub_…`). A secret key is refused: it must never ship
in an app.

Pass your app's version (`app.version`): with it, the first launch on a new version sends
`$app_update`. In Expo, `Application.nativeApplicationVersion` from `expo-application` has it.

## Screens

With React Navigation, hand the container's ref to `trackNavigation` once it's ready. Every route
change sends `$screen` with the route's name:

```tsx
const ref = useNavigationContainerRef()
<NavigationContainer ref={ref} onReady={() => rabolic.trackNavigation(ref)}>
```

With Expo Router, in `app/_layout.tsx`:

```tsx
import { useNavigationContainerRef } from 'expo-router'

const ref = useNavigationContainerRef()
useEffect(() => rabolic.trackNavigation(ref), [ref])
```

Or send screens yourself: `rabolic.screen('Paywall', { variant: 'b' })`.

## What it sends on its own

| Event | When |
|---|---|
| `$app_first_open` | The first launch after install |
| `$app_update` | The first launch on a new `app.version`, with `previous_version` |
| `$app_open` | Each launch and each return to the foreground, with `from_background` |
| `$app_background` | Going to the background, with `foreground_ms`. Queued events are sent then |

A session starts at launch, and again on return after more than 30 seconds in the background.
Background time never counts as active time. `trackLifecycle: false` turns these events off.

## API

| Method | Does |
|---|---|
| `init(options)` | Starts the SDK. A second call returns the first one's promise |
| `track(event, properties?)` | Custom event. snake_case; names starting with `$` are reserved |
| `screen(name, properties?)` | A `$screen` view |
| `trackNavigation(ref)` | `$screen` on every React Navigation route change. Returns a function that stops it |
| `identify(userId, traits?)` | Sets `user_id` on this and later events; sends `$identify` with `traits` |
| `reset()` | Logout: new anonymous id and session, no user id, no super properties |
| `register(properties)` / `unregister(key)` | Super properties, sent with every later event |
| `setConsent(state)`, `optIn()`, `optOut()` | Consent |
| `trackDeepLink(url)` | `$deep_link` for a link the app was opened with. An `rb_aid` parameter (from the web SDK's `appLink()`) is sent as `linked_anonymous_id` |
| `flush()` | Sends the queue now. Never rejects |
| `getAnonymousId()` | This install's anonymous id, or `null` before `init` finishes |

Calls never throw. Problems are logged with `debug: true`.

## Options

| Option | Default | |
|---|---|---|
| `projectKey` | required | `rb_pub_…` |
| `host` | `https://ingest.rabolic.com` | For a first-party proxy |
| `app` | none | `{ version, build, bundle }` |
| `trackLifecycle` | `true` | The four `$app_` events |
| `consent` | `granted` | The state to start with when the app hasn't set one |
| `flushAt` | `20` | Send when this many events are queued (1–500) |
| `flushIntervalMs` | `15000` | Send at least this often |
| `maxQueueSize` | `10000` | Events kept on the device; the oldest go first |
| `debug` | `false` | Log calls and responses |

## Random ids

Ids use `crypto.getRandomValues` when the runtime has it (recent React Native, or the
`react-native-get-random-values` polyfill). Without it they fall back to `Math.random`: unique
enough for analytics, but not unguessable.

## License

MIT
