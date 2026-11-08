import { createRabolic, type RabolicWeb } from './rabolic'

export { createRabolic, type RabolicWeb, type WebEnvironment } from './rabolic'
export { DEFAULT_HOST, type WebOptions } from './options'
export { SNIPPET, snippetFor } from './snippet'
export { VERSION } from './version'
export type { ConsentState, Properties } from '@rabolic/sdk-core'

/** The shared instance: `rabolic.init({ projectKey })`, then `rabolic.track(…)`. */
export const rabolic: RabolicWeb = createRabolic()
