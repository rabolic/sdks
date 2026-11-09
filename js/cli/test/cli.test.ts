import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertValidBatch, MockIngestServer } from '@rabolic/test-utils'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { detectProject, parseArgs, planSetup, relativeImport, run, sendCheck, type Io } from '../src'

const PUB = 'rb_pub_abc123DEF456'
const SECRET = 'rb_live_abc123DEF456'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rabolic-cli-'))
  dirs.push(dir)
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'app', dependencies: deps, ...extra })

describe('detectProject', () => {
  it('tells frameworks, package managers, TypeScript and folders apart', () => {
    expect(detectProject(project({ 'package.json': pkg({ next: '15' }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}', 'src/app/layout.tsx': '' }))).toMatchObject({ framework: 'next', packageManager: 'pnpm', typescript: true, appDir: 'src/app' })
    expect(detectProject(project({ 'package.json': pkg({ next: '15' }), 'pages/_app.js': '' }))).toMatchObject({ framework: 'next', packageManager: 'npm', typescript: false, appDir: null })
    expect(detectProject(project({ 'package.json': pkg({ nuxt: '4' }), 'app/app.vue': '', 'yarn.lock': '' }))).toMatchObject({ framework: 'nuxt', srcDir: 'app', packageManager: 'yarn' })
    expect(detectProject(project({ 'package.json': pkg({ vite: '7', react: '19' }), 'src/main.tsx': '', 'bun.lock': '' }))).toMatchObject({ framework: 'vite', srcDir: 'src', packageManager: 'bun' })
    expect(detectProject(project({ 'package.json': pkg({ expo: '54', 'react-native': '0.81' }) })).framework).toBe('react-native')
    expect(detectProject(project({ 'package.json': pkg({ express: '5' }, { type: 'module' }) }))).toMatchObject({ framework: 'node', esm: true })
    expect(detectProject(project({ 'pubspec.yaml': 'name: app' })).framework).toBe('flutter')
    expect(detectProject(project({ 'index.html': '<html>' })).framework).toBe('html')
    expect(detectProject(project({})).framework).toBe('unknown')
  })
})

describe('planSetup', () => {
  it('Next.js App Router: a client component, the public env variable, and where to render it', () => {
    const dir = project({ 'package.json': pkg({ next: '15' }), 'tsconfig.json': '{}', 'app/layout.tsx': '' })
    const plan = planSetup(detectProject(dir), PUB)
    expect(plan.install).toEqual({ command: 'npm', args: ['install', '@rabolic/web'] })
    expect(plan.files[0]!.path).toBe('app/rabolic.tsx')
    expect(plan.files[0]!.contents).toContain("'use client'")
    expect(plan.files[0]!.contents).toContain('rabolic.init({ projectKey: process.env.NEXT_PUBLIC_RABOLIC_KEY!, trackRoutes: true })')
    expect(plan.env).toEqual({ file: '.env.local', name: 'NEXT_PUBLIC_RABOLIC_KEY', value: PUB })
    expect(plan.next[0]).toBe("In app/layout.tsx, import { Rabolic } from './rabolic' and render <Rabolic /> inside <body>.")
  })

  it('Nuxt, Vite, Node, Flutter and HTML', () => {
    const nuxt = planSetup(detectProject(project({ 'package.json': pkg({ nuxt: '4' }), 'app/app.vue': '' })), PUB)
    expect(nuxt.files[0]!.path).toBe('app/plugins/rabolic.client.ts')
    expect(nuxt.env?.name).toBe('NUXT_PUBLIC_RABOLIC_KEY')

    const vite = planSetup(detectProject(project({ 'package.json': pkg({ vite: '7' }), 'tsconfig.json': '{}', 'src/main.ts': '', 'pnpm-lock.yaml': '' })), PUB, { host: 'https://t.example.com' })
    expect(vite.install).toEqual({ command: 'pnpm', args: ['add', '@rabolic/web'] })
    expect(vite.files[0]!.contents).toContain("projectKey: import.meta.env.VITE_RABOLIC_KEY, trackRoutes: true, host: 'https://t.example.com'")
    expect(vite.next[0]).toBe("At the top of src/main.ts (your entry file), add: import './rabolic'")

    const cjs = planSetup(detectProject(project({ 'package.json': pkg({ express: '5' }) })), SECRET)
    expect(cjs.keyKind).toBe('secret')
    expect(cjs.files[0]!.contents).toContain("const { Rabolic } = require('@rabolic/node')")
    expect(cjs.env).toEqual({ file: '.env', name: 'RABOLIC_SECRET_KEY', value: SECRET })
    const esm = planSetup(detectProject(project({ 'package.json': pkg({ express: '5' }, { type: 'module' }) })), SECRET)
    expect(esm.files[0]!.contents).toContain("import { Rabolic } from '@rabolic/node'")

    const flutter = planSetup(detectProject(project({ 'pubspec.yaml': '' })), PUB)
    expect(flutter.install).toEqual({ command: 'flutter', args: ['pub', 'add', 'rabolic_flutter'] })
    expect(flutter.next[0]).toContain(`RabolicConfig(projectKey: '${PUB}')`)

    const html = planSetup(detectProject(project({ 'index.html': '' })), PUB)
    expect(html.install).toBeNull()
    expect(html.next[0]).toContain(`data-key="${PUB}"`)
  })

  it('React Native: Expo installs through expo install and uses EXPO_PUBLIC_, bare React Native writes the key and needs pods', () => {
    const expo = planSetup(detectProject(project({ 'package.json': pkg({ expo: '54', 'expo-router': '6', 'react-native': '0.81' }), 'tsconfig.json': '{}', 'app/_layout.tsx': '' })), PUB)
    expect(expo.install).toEqual({ command: 'npx', args: ['expo', 'install', '@rabolic/react-native', '@react-native-async-storage/async-storage'] })
    expect(expo.files[0]).toMatchObject({ path: 'rabolic.ts' })
    expect(expo.files[0]!.contents).toContain('void rabolic.init({ projectKey: process.env.EXPO_PUBLIC_RABOLIC_KEY! })')
    expect(expo.env).toEqual({ file: '.env', name: 'EXPO_PUBLIC_RABOLIC_KEY', value: PUB })
    expect(expo.next[0]).toBe("At the top of app/_layout.tsx, add: import '../rabolic'")
    expect(expo.next[1]).toContain('useNavigationContainerRef()')

    const bare = planSetup(detectProject(project({ 'package.json': pkg({ 'react-native': '0.81' }), 'yarn.lock': '', 'src/App.js': '' })), PUB)
    expect(bare.install).toEqual({ command: 'yarn', args: ['add', '@rabolic/react-native', '@react-native-async-storage/async-storage'] })
    expect(bare.files[0]!.contents).toContain(`projectKey: '${PUB}'`)
    expect(bare.env).toBeNull()
    expect(bare.next.at(-1)).toContain('pod install')
  })

  it('relative imports', () => {
    expect(relativeImport('src/main.ts', 'src/rabolic.ts')).toBe('./rabolic')
    expect(relativeImport('main.ts', 'rabolic.ts')).toBe('./rabolic')
    expect(relativeImport('pages/_app.tsx', 'components/rabolic.tsx')).toBe('../components/rabolic')
  })
})

describe('parseArgs', () => {
  it('reads the command and flags in both forms', () => {
    expect(parseArgs(['init', '--key', PUB, '-y'])).toMatchObject({ command: 'init', key: PUB, yes: true })
    expect(parseArgs(['init', `--key=${PUB}`, '--host=https://x.test', '--dry-run'])).toMatchObject({ key: PUB, host: 'https://x.test', dryRun: true })
    expect(parseArgs(['--version']).command).toBe('version')
    expect(parseArgs([]).command).toBe('help')
  })
})

describe('rabolic init and check', () => {
  const ingest = new MockIngestServer()
  beforeAll(() => ingest.start())
  afterAll(() => ingest.stop())

  function io(cwd: string, answers: string[] = []) {
    const lines: string[] = []
    const execs: string[] = []
    const value: Io = {
      cwd,
      out: (l) => lines.push(l),
      ask: async () => answers.shift() ?? '',
      exec: async (command, args) => (execs.push(`${command} ${args.join(' ')}`), 0),
      fetch: globalThis.fetch,
      color: false,
    }
    return { io: value, lines, execs }
  }

  it('sets up a Vite project end to end and sends a valid test event', async () => {
    const dir = project({ 'package.json': pkg({ vite: '7' }), 'tsconfig.json': '{}', 'src/main.ts': '', '.env.local': 'OTHER=1' })
    const t = io(dir, [PUB, 'y'])
    expect(await run(['init', '--host', ingest.url], t.io)).toBe(0)
    expect(t.execs).toEqual(['npm install @rabolic/web'])
    expect(readFileSync(join(dir, 'src/rabolic.ts'), 'utf8')).toContain('import.meta.env.VITE_RABOLIC_KEY')
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(`OTHER=1\nVITE_RABOLIC_KEY=${PUB}\n`)
    const batch = ingest.batches.at(-1)!
    assertValidBatch(batch)
    expect(batch.events[0]).toMatchObject({ event: 'rabolic_cli_check', context: { platform: 'web', user_agent: '' } })
    expect(t.lines.join('\n')).toContain('✓ Rabolic received a test event')
    expect(t.lines.join('\n')).toContain("import './rabolic'")
  })

  it('never overwrites a file or an env value, and asks again for a key of the wrong kind', async () => {
    const dir = project({ 'package.json': pkg({ express: '5' }), 'src/rabolic.js': '// mine', '.env': `RABOLIC_SECRET_KEY=${SECRET}\n`, '.gitignore': '.env\n' })
    const t = io(dir, [PUB, SECRET])
    expect(await run(['init', '-y', '--skip-install', '--host', ingest.url], t.io)).toBe(0)
    const out = t.lines.join('\n')
    expect(out).toContain('That is a publishable key. A server needs a secret key')
    expect(readFileSync(join(dir, 'src/rabolic.js'), 'utf8')).toBe('// mine')
    expect(out).toContain('src/rabolic.js already exists, left as it is.')
    expect(out).toContain('RABOLIC_SECRET_KEY is already set in .env')
    expect(out).not.toContain("isn't in .gitignore")
    expect(t.execs).toEqual([])
  })

  it('refuses a secret key for a site, changes nothing in a dry run, and stops on no', async () => {
    const dir = project({ 'package.json': pkg({ vite: '7' }) })
    expect(await run(['init', '--key', SECRET], io(dir).io)).toBe(1)
    const dry = io(dir)
    expect(await run(['init', '--key', PUB, '--dry-run'], dry.io)).toBe(0)
    expect(existsSync(join(dir, 'rabolic.js'))).toBe(false)
    expect(dry.lines.join('\n')).toContain('Dry run: nothing changed.')
    const no = io(dir, ['n'])
    expect(await run(['init', '--key', PUB, '--host', ingest.url], no.io)).toBe(1)
    expect(existsSync(join(dir, 'rabolic.js'))).toBe(false)
  })

  it('says why an empty folder is not set up', async () => {
    const empty = io(project({}))
    expect(await run(['init'], empty.io)).toBe(1)
    expect(empty.lines[0]).toContain('No package.json, pubspec.yaml or index.html here')
  })

  it('check reports refused keys and rejected events', async () => {
    ingest.script.push({ status: 401, body: { error: 'invalid_key' } })
    expect((await sendCheck(PUB, 'publishable', ingest.url)).message).toContain('The key was refused')
    ingest.script.push({ status: 200, body: { accepted: 0, rejected: [{ event_id: 'x', reason: 'reserved_name' }], dropped: 0 } })
    expect((await sendCheck(SECRET, 'secret', ingest.url)).message).toBe('The test event was rejected: reserved_name.')
    expect((await sendCheck(PUB, 'publishable', 'http://127.0.0.1:9')).ok).toBe(false)
  })
})
