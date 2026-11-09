/**
 * What `rabolic init` does in a project: the packages to install, the files
 * to add, the environment variable to set, and the steps left to the
 * developer. Pure, so every framework's output is tested as text.
 *
 * The CLI only adds new files and appends to an env file. It never edits
 * existing code: the one line that wires the new file in is printed instead.
 */
import { posix } from 'node:path'
import type { Framework, PackageManager, Project } from './detect'

const { join } = posix

export const DEFAULT_HOST = 'https://ingest.rabolic.com'
export const PUBLISHABLE_KEY: RegExp = /^rb_pub_[\w-]{1,120}$/
export const SECRET_KEY: RegExp = /^rb_(live|test)_[\w-]{1,120}$/

export type KeyKind = 'publishable' | 'secret'

export interface Plan {
  keyKind: KeyKind
  install: { command: string; args: string[] } | null
  files: { path: string; contents: string }[]
  env: { file: string; name: string; value: string } | null
  next: string[]
}

export interface PlanOptions {
  host?: string
}

/** The key a framework needs: browsers and apps a publishable one, servers a secret one. */
export function keyKindFor(framework: Framework): KeyKind {
  return framework === 'node' ? 'secret' : 'publishable'
}

/** Why the CLI can't set up this project, or null when it can. */
export function unsupported(framework: Framework): string | null {
  if (framework === 'unknown') return 'No package.json, pubspec.yaml or index.html here. Run this in your project folder, or see https://rabolic.com/sdks for every SDK.'
  return null
}

export function installCommand(pm: PackageManager, pkg: string): { command: string; args: string[] } {
  if (pm === 'npm') return { command: 'npm', args: ['install', pkg] }
  return { command: pm, args: ['add', pkg] }
}

export function planSetup(p: Project, key: string, opts: PlanOptions = {}): Plan {
  const host = opts.host && opts.host !== DEFAULT_HOST ? opts.host : null
  const ext = p.typescript ? 'ts' : 'js'
  const pm = p.packageManager ?? 'npm'

  switch (p.framework) {
    case 'next': {
      const dir = p.appDir ?? (p.srcDir ? join(p.srcDir, 'components') : 'components')
      const file = join(dir, `rabolic.${p.typescript ? 'tsx' : 'jsx'}`)
      const layout = p.appDir ? join(p.appDir, `layout.${p.typescript ? 'tsx' : 'jsx'}`) : join(p.srcDir, 'pages', `_app.${p.typescript ? 'tsx' : 'jsx'}`)
      return {
        keyKind: 'publishable',
        install: installCommand(pm, '@rabolic/web'),
        files: [
          {
            path: file,
            contents: `'use client'

import { useEffect } from 'react'
import { rabolic } from '@rabolic/web'

/** Starts Rabolic once in the browser. Rendered in the root layout. */
export function Rabolic() {
  useEffect(() => {
    rabolic.init({ projectKey: process.env.NEXT_PUBLIC_RABOLIC_KEY${p.typescript ? '!' : ''}, trackRoutes: true${host ? `, host: '${host}'` : ''} })
  }, [])
  return null
}
`,
          },
        ],
        env: { file: '.env.local', name: 'NEXT_PUBLIC_RABOLIC_KEY', value: key },
        next: [`In ${layout}, import { Rabolic } from '${relativeImport(layout, file)}' and render <Rabolic /> ${p.appDir ? 'inside <body>' : 'next to <Component {...pageProps} />'}.`],
      }
    }
    case 'nuxt': {
      const file = join(p.srcDir, 'plugins', 'rabolic.client.ts')
      return {
        keyKind: 'publishable',
        install: installCommand(pm, '@rabolic/web'),
        files: [
          {
            path: file,
            contents: `import { rabolic } from '@rabolic/web'

/** Starts Rabolic in the browser (.client), with route tracking for the Vue router. */
export default defineNuxtPlugin(() => {
  rabolic.init({ projectKey: useRuntimeConfig().public.rabolicKey as string, trackRoutes: true${host ? `, host: '${host}'` : ''} })
  return { provide: { rabolic } }
})
`,
          },
        ],
        env: { file: '.env', name: 'NUXT_PUBLIC_RABOLIC_KEY', value: key },
        next: [`In nuxt.config, add runtimeConfig: { public: { rabolicKey: '' } }. Nuxt fills it from NUXT_PUBLIC_RABOLIC_KEY.`],
      }
    }
    case 'vite': {
      const file = join(p.srcDir, `rabolic.${ext}`)
      const main = join(p.srcDir, `main.${ext}`)
      return {
        keyKind: 'publishable',
        install: installCommand(pm, '@rabolic/web'),
        files: [
          {
            path: file,
            contents: `import { rabolic } from '@rabolic/web'

rabolic.init({ projectKey: import.meta.env.VITE_RABOLIC_KEY, trackRoutes: true${host ? `, host: '${host}'` : ''} })

export { rabolic }
`,
          },
        ],
        env: { file: '.env.local', name: 'VITE_RABOLIC_KEY', value: key },
        next: [`At the top of ${main} (your entry file), add: import '${relativeImport(main, file)}'`],
      }
    }
    case 'node': {
      const file = join(p.srcDir, `rabolic.${ext}`)
      const create = `new Rabolic({ secretKey: process.env.RABOLIC_SECRET_KEY${p.typescript ? '!' : ''}${host ? `, host: '${host}'` : ''} })`
      return {
        keyKind: 'secret',
        install: installCommand(pm, '@rabolic/node'),
        files: [
          {
            path: file,
            contents: p.typescript || p.esm
              ? `import { Rabolic } from '@rabolic/node'

/** One client for the process. Call rabolic.shutdown() before it exits. */
export const rabolic = ${create}
`
              : `const { Rabolic } = require('@rabolic/node')

/** One client for the process. Call rabolic.shutdown() before it exits. */
const rabolic = ${create}

module.exports = { rabolic }
`,
          },
        ],
        env: { file: '.env', name: 'RABOLIC_SECRET_KEY', value: key },
        next: [`Import rabolic from ${file} where you track server events or purchases. Load .env in production your usual way; the key is a secret.`],
      }
    }
    case 'react-native': {
      const file = join(p.srcDir, `rabolic.${ext}`)
      const packages = ['@rabolic/react-native', '@react-native-async-storage/async-storage']
      const keyExpr = p.expo ? `process.env.EXPO_PUBLIC_RABOLIC_KEY${p.typescript ? '!' : ''}` : `'${key}'`
      const next = p.expo?.router
        ? [`At the top of app/_layout.${p.typescript ? 'tsx' : 'jsx'}, add: import '${relativeImport('app/_layout.tsx', file)}'`,
           `For screens, in the same layout: const ref = useNavigationContainerRef() (from expo-router), then useEffect(() => rabolic.trackNavigation(ref), [ref]).`]
        : [`At the top of your entry file (index.js or App.${p.typescript ? 'tsx' : 'js'}), add: import '${relativeImport('index.js', file)}'`,
           'For screens, pass your NavigationContainer ref: <NavigationContainer ref={ref} onReady={() => rabolic.trackNavigation(ref)}>.']
      if (!p.expo) next.push('Then run cd ios && pod install, for AsyncStorage.')
      return {
        keyKind: 'publishable',
        // Expo picks the AsyncStorage version that matches the SDK.
        install: p.expo ? { command: 'npx', args: ['expo', 'install', ...packages] } : { ...installCommand(pm, packages[0]!), args: [...installCommand(pm, packages[0]!).args, packages[1]!] },
        files: [
          {
            path: file,
            contents: `import { rabolic } from '@rabolic/react-native'

// Starts Rabolic once, at app start. Calls made before it finishes are kept.
void rabolic.init({ projectKey: ${keyExpr}${host ? `, host: '${host}'` : ''} })

export { rabolic }
`,
          },
        ],
        // A publishable key is public; bare React Native has no env files, so it is written in the file.
        env: p.expo ? { file: '.env', name: 'EXPO_PUBLIC_RABOLIC_KEY', value: key } : null,
        next,
      }
    }
    case 'flutter':
      return {
        keyKind: 'publishable',
        install: { command: 'flutter', args: ['pub', 'add', 'rabolic_flutter'] },
        files: [],
        env: null,
        next: [
          `In lib/main.dart, before runApp():
    WidgetsFlutterBinding.ensureInitialized();
    await Rabolic.init(const RabolicConfig(projectKey: '${key}'${host ? `, host: '${host}'` : ''}));
  with import 'package:rabolic_flutter/rabolic_flutter.dart';`,
        ],
      }
    case 'html':
      return {
        keyKind: 'publishable',
        install: null,
        files: [],
        env: null,
        next: [`Paste this into <head> on every page:
    <script async src="https://cdn.rabolic.com/v1/rabolic.js" data-key="${key}"${host ? ` data-host="${host}"` : ''}></script>`],
      }
    default:
      throw new Error(unsupported(p.framework) ?? `No setup for ${p.framework}`)
  }
}

/** `src/main.ts` importing `src/rabolic.ts` → `./rabolic`. Extensions are dropped. */
export function relativeImport(from: string, to: string): string {
  const a = from.split('/').slice(0, -1)
  const b = to.replace(/\.(tsx?|jsx?)$/, '').split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  const up = a.length - i
  const rest = b.slice(i).join('/')
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`
}
