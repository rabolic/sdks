import type { Clock, PageContext } from '@rabolic/sdk-core'
import { startActivityMeter, type PageMetrics } from './activity'
import { pageContext } from './context'

export interface PageTrackerHooks {
  pageview(page: PageContext): void
  pageLeave(page: PageContext, metrics: PageMetrics): void
  /** The page is being hidden or unloaded: send what is queued now. */
  hidden(): void
  trackRoutes(): boolean
  trackPageLeave(): boolean
}

export interface PageTracker {
  /** The current page, with the in-app referrer after SPA navigation. */
  currentPage(): PageContext
}

/**
 * Automatic page views and page leaves. One `$pageview` per page load and per
 * SPA route; one `$page_leave` per page view, sent on route change or the first
 * time the page is hidden. Runs for the page lifetime.
 */
export function startPageTracker(win: Window, clock: Clock, hooks: PageTrackerHooks): PageTracker {
  const meter = startActivityMeter(win, clock)
  const { history, document } = win
  let referrer = document.referrer
  let routeKey = ''
  let page: PageContext = {}
  let leaveSent = false

  const currentPage = (): PageContext => pageContext(win, referrer)
  /** Same-URL navigations and hash-only changes are not new page views. */
  const currentRouteKey = (): string => win.location.origin + win.location.pathname + win.location.search

  function enterPage(): void {
    routeKey = currentRouteKey()
    page = currentPage()
    leaveSent = false
    meter.reset()
    hooks.pageview(page)
  }

  function sendLeave(): void {
    if (leaveSent || !hooks.trackPageLeave()) return
    leaveSent = true
    hooks.pageLeave(page, meter.snapshot())
  }

  function onRouteChange(): void {
    if (!hooks.trackRoutes() || currentRouteKey() === routeKey) return
    sendLeave()
    referrer = page.url ?? referrer
    enterPage()
  }

  function onHide(): void {
    meter.hidden()
    sendLeave()
    hooks.hidden()
  }

  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name]
    const patched: History['pushState'] = function (this: History, ...args) {
      const result = original.apply(this, args)
      onRouteChange()
      return result
    }
    history[name] = patched
  }
  win.addEventListener('popstate', onRouteChange)
  win.addEventListener('pagehide', onHide)
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? onHide() : meter.visible()))
  enterPage()

  return { currentPage }
}
