import { createRabolic, type RabolicWeb, type WebEnvironment } from './rabolic'

type StubCall = [method: string, ...args: unknown[]]

/**
 * Script-tag bootstrap: replaces the loader stub (an array of queued calls) with
 * the real SDK and replays the calls in order. Without a queued `init`, it
 * initializes from `data-key` / `data-host` on the script tag.
 */
export function installGlobal(win: Window, environment: WebEnvironment = {}): RabolicWeb {
  const host = win as Window & { rabolic?: unknown }
  const existing = host.rabolic
  // Already loaded (the script was included twice): keep the running instance.
  if (existing && !Array.isArray(existing)) return existing as RabolicWeb

  const instance = createRabolic({ ...environment, window: win })
  const queued = (existing ?? []) as StubCall[]
  host.rabolic = instance

  const script = queued.some((call) => Array.isArray(call) && call[0] === 'init') ? null : findScriptTag(win.document)
  const key = script?.getAttribute('data-key')
  if (key) instance.init({ projectKey: key, host: script?.getAttribute('data-host') ?? undefined })

  for (const call of queued) {
    // Only the SDK's own methods, whatever else ended up in the array.
    if (Array.isArray(call) && Object.prototype.hasOwnProperty.call(instance, call[0])) {
      ;(instance[call[0] as keyof RabolicWeb] as (...values: unknown[]) => unknown)(...call.slice(1))
    }
  }
  return instance
}

/** The `<script>` running us (set while a classic script, async or not, first executes), if it has `data-key`. */
export function findScriptTag(doc: Document): Element | null {
  const current = doc.currentScript
  return current?.hasAttribute('data-key') ? current : null
}
