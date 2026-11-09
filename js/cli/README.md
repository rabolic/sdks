# rabolic

Set up [Rabolic](https://rabolic.com) analytics in your project with one command:

```bash
npx rabolic init
```

It looks at the folder you run it in, then:

1. installs the right SDK with your package manager (npm, pnpm, yarn or bun; `flutter pub add` for Flutter);
2. adds one file that starts the SDK;
3. puts the key in your env file;
4. sends one test event (`rabolic_cli_check`), so you can watch it arrive on the Live page;
5. prints the one line you add yourself.

It only adds new files and appends to the env file. It never edits your existing code, and it
never overwrites a file or an env value that is already there.

| Project | Package | File it adds | Env variable |
|---|---|---|---|
| Next.js (App or Pages Router) | `@rabolic/web` | `app/rabolic.tsx` (a client component) | `NEXT_PUBLIC_RABOLIC_KEY` in `.env.local` |
| Nuxt | `@rabolic/web` | `plugins/rabolic.client.ts` | `NUXT_PUBLIC_RABOLIC_KEY` in `.env` |
| Vite (React, Vue, Svelte, …) | `@rabolic/web` | `src/rabolic.ts` | `VITE_RABOLIC_KEY` in `.env.local` |
| Node.js server | `@rabolic/node` | `src/rabolic.ts` | `RABOLIC_SECRET_KEY` in `.env` |
| Expo | `@rabolic/react-native` and AsyncStorage, with `npx expo install` | `rabolic.ts` | `EXPO_PUBLIC_RABOLIC_KEY` in `.env` |
| React Native (bare) | `@rabolic/react-native` and AsyncStorage | `src/rabolic.ts`, with the publishable key in it | none |
| Flutter | `rabolic_flutter` | none: prints the `Rabolic.init` call for `main.dart` | none |
| Static site (`index.html`) | none | none: prints the `<script>` tag | none |

Sites and apps use the project's **publishable key** (`rb_pub_…`). A server uses a **secret key**
(`rb_live_…` or `rb_test_…`), which can send revenue and must never ship in a browser or an app.
The CLI refuses the wrong kind. Both are in Rabolic → Integrations → Keys.

## Options

```
npx rabolic init [--key <key>] [--host <url>] [--yes] [--dry-run] [--skip-install]
npx rabolic check --key <key> [--host <url>]
```

| Option | |
|---|---|
| `--key` | The key, instead of pasting it when asked |
| `--host` | Your ingest host, if you proxy it (default `https://ingest.rabolic.com`) |
| `--yes`, `-y` | Don't ask before installing and writing files |
| `--dry-run` | Print the plan and the files, change nothing |
| `--skip-install` | Don't run the package manager |

`npx rabolic check --key …` only sends the test event: a quick way to test a key, a host or a proxy.

`npm create rabolic` does the same as `npx rabolic init`.

## License

MIT
