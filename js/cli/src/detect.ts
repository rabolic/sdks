/**
 * What kind of project the CLI is run in, from the files in its folder:
 * package.json dependencies, a pubspec.yaml, or a plain index.html.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Framework = 'next' | 'nuxt' | 'vite' | 'react-native' | 'node' | 'flutter' | 'html' | 'unknown'
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface Project {
  dir: string
  framework: Framework
  /** For JavaScript projects; null for Flutter, HTML and unknown folders. */
  packageManager: PackageManager | null
  typescript: boolean
  /** The folder app code lives in, relative to `dir`: `src`, `app` (Nuxt 4) or `` (the root). */
  srcDir: string
  /** Next.js only: the App Router's folder (`app` or `src/app`), or null for the Pages Router. */
  appDir: string | null
  /** package.json says "type": "module". */
  esm: boolean
  /** React Native through Expo (expo-router, when `router` is true). */
  expo?: { router: boolean }
}

interface PackageJson {
  type?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const has = (dir: string, ...path: string[]) => existsSync(join(dir, ...path))

export function detectProject(dir: string): Project {
  if (has(dir, 'pubspec.yaml')) {
    return { dir, framework: 'flutter', packageManager: null, typescript: false, srcDir: 'lib', appDir: null, esm: false }
  }
  const pkg = readPackageJson(dir)
  if (!pkg) {
    const framework: Framework = has(dir, 'index.html') ? 'html' : 'unknown'
    return { dir, framework, packageManager: null, typescript: false, srcDir: '', appDir: null, esm: false }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const typescript = 'typescript' in deps || has(dir, 'tsconfig.json')
  const packageManager = detectPackageManager(dir)
  const src = has(dir, 'src') ? 'src' : ''
  const esm = pkg.type === 'module'

  if ('next' in deps) {
    const appDir = has(dir, 'src', 'app') ? 'src/app' : has(dir, 'app') ? 'app' : null
    return { dir, framework: 'next', packageManager, typescript, srcDir: src, appDir, esm }
  }
  if ('nuxt' in deps) {
    // Nuxt 4 keeps app code in app/; Nuxt 3 in the root (or srcDir, rarely changed).
    return { dir, framework: 'nuxt', packageManager, typescript: true, srcDir: has(dir, 'app') ? 'app' : '', appDir: null, esm: false }
  }
  if ('react-native' in deps || 'expo' in deps) {
    const expo = 'expo' in deps ? { router: 'expo-router' in deps } : undefined
    return { dir, framework: 'react-native', packageManager, typescript, srcDir: src, appDir: null, esm, ...(expo ? { expo } : {}) }
  }
  if ('vite' in deps) {
    return { dir, framework: 'vite', packageManager, typescript, srcDir: src, appDir: null, esm }
  }
  // A package.json without a front-end framework is a server.
  return { dir, framework: 'node', packageManager, typescript, srcDir: src, appDir: null, esm }
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return null
  }
}

/** From the lockfile; npm when there is none. */
export function detectPackageManager(dir: string): PackageManager {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm'
  if (has(dir, 'yarn.lock')) return 'yarn'
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun'
  return 'npm'
}

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  vite: 'Vite',
  'react-native': 'React Native',
  node: 'Node.js',
  flutter: 'Flutter',
  html: 'a static site',
  unknown: 'an unknown project',
}
