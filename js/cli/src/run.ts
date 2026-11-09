/**
 * `rabolic init`: detect the project, take the key, install the SDK, add one
 * file, set the env variable, send a test event, and say what's left.
 * `rabolic check --key …` only sends the test event.
 *
 * Input and output go through `Io`, so the whole flow runs in tests.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { sendCheck } from './check'
import { detectProject, FRAMEWORK_LABEL } from './detect'
import { DEFAULT_HOST, keyKindFor, planSetup, PUBLISHABLE_KEY, SECRET_KEY, unsupported, type KeyKind, type Plan } from './plan'
import { VERSION } from './version'

export interface Io {
  cwd: string
  out(line: string): void
  ask(question: string): Promise<string>
  exec(command: string, args: string[], cwd: string): Promise<number>
  fetch: typeof fetch
  color: boolean
}

interface Args {
  command: string
  key?: string
  host?: string
  yes: boolean
  dryRun: boolean
  skipInstall: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'help', yes: false, dryRun: false, skipInstall: false }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) args.command = rest.shift()!
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    const value = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i])
    if (a === '--key' || a.startsWith('--key=')) args.key = value()
    else if (a === '--host' || a.startsWith('--host=')) args.host = value()
    else if (a === '--yes' || a === '-y') args.yes = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--skip-install') args.skipInstall = true
    else if (a === '--version' || a === '-v') args.command = 'version'
    else if (a === '--help' || a === '-h') args.command = 'help'
  }
  return args
}

const HELP = `rabolic ${VERSION}: set up Rabolic analytics

Usage
  npx rabolic init            Set up the SDK in this project
  npx rabolic check --key K   Send a test event with a key

Options
  --key <key>      The project key (rb_pub_… for sites and apps, rb_live_… for servers)
  --host <url>     Your ingest host, if you proxy it (default ${DEFAULT_HOST})
  --yes, -y        Don't ask before installing and writing files
  --dry-run        Show what would change, change nothing
  --skip-install   Don't install the package

Keys are in Rabolic → Integrations → Keys.`

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv)
  const c = paint(io.color)
  if (args.command === 'version') return io.out(VERSION), 0
  if (args.command === 'help') return io.out(HELP), 0
  const host = args.host ?? DEFAULT_HOST
  if (!/^https?:\/\//.test(host)) return io.out(c.red(`--host must be a URL, like ${DEFAULT_HOST}`)), 1

  if (args.command === 'check') {
    const key = args.key ?? ''
    const kind: KeyKind | null = PUBLISHABLE_KEY.test(key) ? 'publishable' : SECRET_KEY.test(key) ? 'secret' : null
    if (!kind) return io.out(c.red('check needs --key with a project key (rb_pub_…, rb_live_… or rb_test_…).')), 1
    const result = await sendCheck(key, kind, host, io.fetch)
    io.out(result.ok ? c.green(`✓ ${result.message}`) : c.red(`✗ ${result.message}`))
    return result.ok ? 0 : 1
  }
  if (args.command !== 'init') return io.out(`Unknown command: ${args.command}\n\n${HELP}`), 1

  const project = detectProject(io.cwd)
  const why = unsupported(project.framework)
  if (why) return io.out(c.yellow(why)), 1
  const details = [project.packageManager, project.typescript ? 'TypeScript' : null].filter(Boolean).join(', ')
  io.out(`Found ${c.bold(FRAMEWORK_LABEL[project.framework])}${details ? ` (${details})` : ''}.`)

  const kind = keyKindFor(project.framework)
  const key = await takeKey(args.key, kind, io, c)
  if (!key) return 1
  const plan = planSetup(project, key, { host })

  io.out('')
  io.out(c.bold('This will:'))
  for (const line of describe(plan, args)) io.out(`  • ${line}`)
  if (args.dryRun) {
    for (const f of plan.files) io.out(`\n${c.dim(`── ${f.path}`)}\n${f.contents}`)
    io.out(c.dim('\nDry run: nothing changed.'))
    return 0
  }
  if (!args.yes) {
    const answer = (await io.ask('Continue? (Y/n) ')).trim().toLowerCase()
    if (answer && answer !== 'y' && answer !== 'yes') return io.out('Nothing changed.'), 1
  }

  if (plan.install && !args.skipInstall) {
    io.out(c.dim(`\n$ ${plan.install.command} ${plan.install.args.join(' ')}`))
    const code = await io.exec(plan.install.command, plan.install.args, io.cwd)
    if (code !== 0) return io.out(c.red(`✗ ${plan.install.command} exited with ${code}. Fix that and run npx rabolic init again.`)), 1
  }
  for (const f of plan.files) {
    const path = join(io.cwd, f.path)
    if (existsSync(path)) {
      io.out(c.yellow(`• ${f.path} already exists, left as it is.`))
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, f.contents)
    io.out(c.green(`✓ Added ${f.path}`))
  }
  if (plan.env) io.out(writeEnv(io.cwd, plan.env, c))
  if (plan.keyKind === 'secret' && !gitIgnores(io.cwd, plan.env?.file ?? '.env')) io.out(c.yellow(`! ${plan.env?.file ?? '.env'} isn't in .gitignore. Add it: the secret key must not be committed.`))

  const check = await sendCheck(key, plan.keyKind, host, io.fetch)
  io.out(check.ok ? c.green(`✓ ${check.message}`) : c.yellow(`! ${check.message}`))

  io.out('')
  io.out(c.bold(plan.next.length === 1 ? 'One step left:' : 'Steps left:'))
  for (const line of plan.next) io.out(`  ${line}`)
  io.out(`\nDocs: https://rabolic.com/sdks`)
  return 0
}

async function takeKey(given: string | undefined, kind: KeyKind, io: Io, c: Paint): Promise<string | null> {
  const pattern = kind === 'publishable' ? PUBLISHABLE_KEY : SECRET_KEY
  const label = kind === 'publishable' ? 'publishable key (rb_pub_…)' : 'secret key (rb_live_… or rb_test_…)'
  let key = given?.trim() ?? ''
  for (let attempt = 0; !pattern.test(key); attempt++) {
    if (key) {
      const wrongKind = kind === 'publishable' ? SECRET_KEY.test(key) : PUBLISHABLE_KEY.test(key)
      io.out(c.red(wrongKind ? (kind === 'publishable' ? 'That is a secret key: it must never ship in a site or an app. Use the publishable key.' : 'That is a publishable key. A server needs a secret key, which can send revenue.') : `That doesn't look like a ${label}.`))
    }
    if (given || attempt >= 3) return null
    key = (await io.ask(`Paste the project's ${label} from Rabolic → Integrations → Keys: `)).trim()
  }
  return key
}

function describe(plan: Plan, args: Args): string[] {
  const out: string[] = []
  if (plan.install && !args.skipInstall) out.push(`run ${plan.install.command} ${plan.install.args.join(' ')}`)
  for (const f of plan.files) out.push(`add ${f.path}`)
  if (plan.env) out.push(`set ${plan.env.name} in ${plan.env.file}`)
  out.push('send one test event to check the key')
  return out
}

function writeEnv(cwd: string, env: NonNullable<Plan['env']>, c: Paint): string {
  const path = join(cwd, env.file)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (new RegExp(`^${env.name}=`, 'm').test(current)) return c.yellow(`• ${env.name} is already set in ${env.file}, left as it is.`)
  appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${env.name}=${env.value}\n`)
  return c.green(`✓ Set ${env.name} in ${env.file}`)
}

function gitIgnores(cwd: string, file: string): boolean {
  try {
    const lines = readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
    return lines.some((l) => {
      const rule = l.replace(/^\//, '')
      return rule === file || (rule.endsWith('*') && file.startsWith(rule.slice(0, -1)))
    })
  } catch {
    return false
  }
}

type Paint = ReturnType<typeof paint>
function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33') }
}

/** The real terminal: stdin prompts, inherited stdio for the package manager. */
export function terminalIo(): Io {
  return {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
    exec: (command, args, cwd) =>
      new Promise((resolve) => {
        // Windows runs npm, pnpm and yarn through .cmd shims, which need a shell.
        const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
        child.on('close', (code) => resolve(code ?? 1))
        child.on('error', () => resolve(127))
      }),
    fetch: globalThis.fetch,
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
  }
}
