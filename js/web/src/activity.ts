import type { Clock } from '@rabolic/sdk-core'

/** An interaction keeps the visitor "active" for this long. */
export const IDLE_AFTER_MS = 30_000

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart']

export interface PageMetrics {
  active_ms: number
  /** Furthest point of the page seen, 0–1. */
  scroll_depth: number
}

/**
 * Measures active time (page visible and interacted with in the last 30 s) and
 * scroll depth. It listens only to the fact that an interaction happened, never
 * to what was typed or clicked.
 */
export interface ActivityMeter {
  /** Starts measuring a new page view. */
  reset(): void
  hidden(): void
  visible(): void
  snapshot(): PageMetrics
}

export function startActivityMeter(win: Window, clock: Clock): ActivityMeter {
  let activeMs = 0
  /** Last interaction while visible; `undefined` while hidden. */
  let lastActivity: number | undefined
  let maxDepth = 0
  const isVisible = (): boolean => win.document.visibilityState !== 'hidden'

  function depth(): number {
    const { documentElement, body } = win.document
    const height = Math.max(documentElement.scrollHeight, body?.scrollHeight ?? 0)
    const seen = (win.scrollY || 0) + (win.innerHeight || 0)
    return height > 0 ? Math.min(1, seen / height) : 1
  }

  /** Counts the time since the last interaction, up to the idle limit. */
  function accrue(now: number): void {
    if (lastActivity !== undefined) activeMs += Math.max(0, Math.min(now - lastActivity, IDLE_AFTER_MS))
    maxDepth = Math.max(maxDepth, depth())
  }

  function onActivity(): void {
    if (!isVisible()) return
    const now = clock.now()
    accrue(now)
    lastActivity = now
  }

  for (const type of ACTIVITY_EVENTS) win.addEventListener(type, onActivity, { passive: true, capture: true })

  const meter: ActivityMeter = {
    reset() {
      activeMs = 0
      lastActivity = isVisible() ? clock.now() : undefined
      maxDepth = depth()
    },
    hidden() {
      accrue(clock.now())
      lastActivity = undefined
    },
    visible() {
      lastActivity = clock.now()
    },
    snapshot() {
      const now = clock.now()
      accrue(now)
      if (lastActivity !== undefined) lastActivity = now
      return { active_ms: Math.round(activeMs), scroll_depth: Math.round(maxDepth * 100) / 100 }
    },
  }
  meter.reset()
  return meter
}
