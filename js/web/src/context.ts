import { truncate, type EventContext, type PageContext } from '@rabolic/sdk-core'

/** Schema limits for `context.page` and friends. */
const MAX_URL = 2048
const MAX_TITLE = 512

export function pageContext(win: Window, referrer: string): PageContext {
  const { location, document } = win
  const page: PageContext = {
    url: truncate(location.href, MAX_URL),
    path: truncate(location.pathname, MAX_URL),
  }
  if (document.title) page.title = truncate(document.title, MAX_TITLE)
  if (referrer) page.referrer = truncate(referrer, MAX_URL)
  return page
}

/** The parts of `context` that do not change during a page lifetime. No fingerprinting signals beyond these. */
export function staticContext(win: Window): EventContext {
  const context: EventContext = { platform: 'web' }
  const { navigator, screen } = win
  if (navigator.language) context.locale = truncate(navigator.language, 35)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (timezone) context.timezone = truncate(timezone, 64)
  if (screen && screen.width > 0) {
    context.screen = { width: screen.width, height: screen.height, density: win.devicePixelRatio || 1 }
  }
  if (navigator.userAgent) context.user_agent = truncate(navigator.userAgent, 1024)
  return context
}
