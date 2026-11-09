import { createRabolic, type RabolicReactNative } from './rabolic'

export { createRabolic, resolveOptions, DEFAULT_HOST, type NavigationRefLike, type RabolicReactNative, type ReactNativeEnvironment, type ReactNativeOptions } from './rabolic'
export type { AppInfo } from './context'
export type { ConsentState, Properties } from '@rabolic/sdk-core'
export { VERSION } from './version'

/** The app-wide instance. `createRabolic()` makes an independent one. */
export const rabolic: RabolicReactNative = createRabolic()
