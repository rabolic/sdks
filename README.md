# Rabolic SDKs

Open-source SDKs for [Rabolic](https://rabolic.com), product analytics for web
and mobile apps. Each SDK sends events to the Rabolic ingest API, using the
protocol in [`spec/`](spec/).

| Package | Platform | Install | Source |
|---|---|---|---|
| [`@rabolic/web`](https://www.npmjs.com/package/@rabolic/web) | Browsers: npm or a `<script>` tag | `npm i @rabolic/web` | [`js/web`](js/web) |
| [`@rabolic/node`](https://www.npmjs.com/package/@rabolic/node) | Node.js servers | `npm i @rabolic/node` | [`js/node`](js/node) |
| [`rabolic_flutter`](https://pub.dev/packages/rabolic_flutter) | Flutter: iOS, Android, web | `flutter pub add rabolic_flutter` | [`flutter`](flutter) |

Script tag for websites. Replace the key with your project's publishable key:

```html
<script async src="https://cdn.rabolic.com/v1/rabolic.js" data-key="rb_pub_…"></script>
```

Each package's README covers its options, consent, identity and revenue.

## Repository layout

```
spec/       the ingest protocol and the JSON Schema every SDK is tested against
js/         pnpm workspace: web, node, the shared core (bundled into both) and test utils
flutter/    the Flutter package and an example app
```

The schema in `spec/schema/batch.schema.json` is the contract:
- every batch an SDK builds in its tests is validated against it;
- the Rabolic ingest service validates incoming batches against the same file.

## Develop

```bash
# JavaScript (Node 20+, pnpm 11)
cd js && pnpm install && pnpm -r typecheck && pnpm -r test && pnpm -r build

# Flutter (Flutter 3.38+)
cd flutter && flutter pub get && flutter analyze && flutter test
```

Pull requests run both suites. A change to `spec/` needs matching changes in
every SDK in the same pull request.

## Releases

Pushing a tag publishes a release from GitHub Actions, without stored tokens:
- npm uses trusted publishing with provenance;
- pub.dev uses automated publishing.

| Tag | Publishes |
|---|---|
| `js-v1.2.3` | `@rabolic/web` and `@rabolic/node` at 1.2.3. Both `package.json` versions must already say 1.2.3 |
| `flutter-v1.2.3` | `rabolic_flutter` 1.2.3. `pubspec.yaml` and `CHANGELOG.md` must already say 1.2.3 |

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
