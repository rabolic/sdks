/** The device context every event carries, read once at startup. */
import type { EventContext } from '@rabolic/sdk-core'
import type { DimensionsLike, PlatformLike } from './host'

export interface AppInfo {
  version?: string
  build?: string
  bundle?: string
}

export function deviceContext(platform: PlatformLike, dimensions: DimensionsLike, app: AppInfo | undefined): EventContext {
  const ios = platform.OS === 'ios'
  const screen = safe(() => dimensions.get('screen'))
  const shortSide = screen ? Math.min(screen.width, screen.height) : 0
  // Android has no isPad; 600 dp on the short side is its own tablet line.
  const tablet = ios ? platform.isPad === true : shortSide >= 600
  const intl = safe(() => Intl.DateTimeFormat().resolvedOptions())
  const context: EventContext = {
    os: { name: ios ? 'iOS' : 'Android', version: String(platform.constants?.osVersion ?? platform.Version ?? '') },
    device: {
      type: tablet ? 'tablet' : 'mobile',
      ...(platform.constants?.Model ? { model: platform.constants.Model } : {}),
    },
  }
  const manufacturer = ios ? 'Apple' : (platform.constants?.Manufacturer ?? platform.constants?.Brand)
  if (manufacturer) context.device!.manufacturer = manufacturer
  const osVersion = String(platform.constants?.osVersion ?? platform.Version ?? '')
  if (!osVersion) delete context.os!.version
  if (screen) context.screen = { width: Math.round(screen.width), height: Math.round(screen.height), density: screen.scale }
  if (intl?.locale) context.locale = intl.locale
  if (intl?.timeZone) context.timezone = intl.timeZone
  const appInfo = Object.fromEntries(Object.entries(app ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''))
  if (Object.keys(appInfo).length) context.app = appInfo
  return context
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}
