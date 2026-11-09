# Rabolic SDKs

Open-source SDKs for [Rabolic](https://rabolic.com), product analytics for web
and mobile apps. Each SDK sends events to the Rabolic ingest API, using the
protocol in [`spec/`](spec/).

| Package | Platform | Install | Source |
|---|---|---|---|
| [`@rabolic/web`](https://www.npmjs.com/package/@rabolic/web) | Browsers: npm or a `<script>` tag | `npm i @rabolic/web` | [`js/web`](js/web) |
| [`@rabolic/node`](https://www.npmjs.com/package/@rabolic/node) | Node.js servers | `npm i @rabolic/node` | [`js/node`](js/node) |
| [`rabolic_flutter`](https://pub.dev/packages/rabolic_flutter) | Flutter: iOS, Android, web | `flutter pub add rabolic_flutter` | [`flutter`](flutter) |
| [`rabolic`](https://www.npmjs.com/package/rabolic) | Setup CLI for all of the above | `npx rabolic init` | [`js/cli`](js/cli) |

The quickest start: run `npx rabolic init` in your project. It installs the right SDK, adds one
file, sets the key and sends a test event ([details](js/cli)).

Script tag for websites. Replace the key with your project's publishable key:

```html
<script async src="https://cdn.rabolic.com/v1/rabolic.js" data-key="rb_pub_…"></script>
```

Each package's README covers its options, consent and identity. Revenue is
recorded from servers, with `@rabolic/node` or Dodo Payments webhooks.

## Repository layout

```
spec/       the ingest protocol and the JSON Schema every SDK is tested against
js/         pnpm workspace: web, node, the shared core (bundled into both), the setup CLI
            (cli, and create-rabolic for `npm create rabolic`) and test utils
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

Pushing a tag publishes a release from GitHub Actions:
- npm uses trusted publishing with provenance; no token is stored.
- pub.dev uses automated publishing; no token is stored.
- `cdn.rabolic.com` is a Cloudflare R2 bucket. It is written with an R2 token that can only write to that bucket, kept in the `cdn` environment.

| Tag | Publishes |
|---|---|
| `js-v1.2.3` | `@rabolic/web`, `@rabolic/node`, `rabolic` (the CLI) and `create-rabolic`, all at 1.2.3. Every `package.json` and `src/version.ts` must already say 1.2.3; a version already on npm is skipped. The web `<script>` build goes to `cdn.rabolic.com/v1/1.2.3/rabolic.js` and, unless it is a pre-release, to `/v1/rabolic.js` |
| `flutter-v1.2.3` | `rabolic_flutter` 1.2.3. `pubspec.yaml` and `CHANGELOG.md` must already say 1.2.3 |

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
