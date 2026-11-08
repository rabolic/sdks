/**
 * Logging sink. Keys never reach the logger: no call site passes one, and the
 * envelope is never logged whole.
 */
export interface Logger {
  /** Only printed with `debug: true`. */
  debug(message: string, ...details: unknown[]): void
  /** Always printed. Reserved for problems the developer must fix (bad key, malformed batch). */
  warn(message: string, ...details: unknown[]): void
}

interface ConsoleLike {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
}

const PREFIX = '[rabolic]'

export function createLogger(debugEnabled: () => boolean): Logger {
  const output = (globalThis as { console?: ConsoleLike }).console
  return {
    debug(message, ...details) {
      if (debugEnabled()) output?.log(PREFIX, message, ...details)
    },
    warn(message, ...details) {
      output?.warn(PREFIX, message, ...details)
    },
  }
}

export const silentLogger: Logger = { debug() {}, warn() {} }
