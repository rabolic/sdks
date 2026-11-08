/**
 * Everything core needs from the host runtime, injected so tests can use fake
 * clocks and timers, and so other runtimes (React Native) can plug in their own.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}

export type TimerHandle = unknown

export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** Fills `bytes` with cryptographically secure random values. */
export type RandomBytes = (bytes: Uint8Array) => Uint8Array

/** Uniform number in [0, 1). Used only for backoff jitter, never for ids. */
export type RandomFraction = () => number

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T
}

interface TimerGlobals {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = { now: () => Date.now() }

/** Looks the globals up on every call so test frameworks that swap them (fake timers) are honoured. */
export const systemTimers: Timers = {
  setTimeout: (callback, ms) => (globalThis as unknown as TimerGlobals).setTimeout(callback, ms),
  clearTimeout: (handle) => (globalThis as unknown as TimerGlobals).clearTimeout(handle),
}

/** Web Crypto, present in browsers, Node 20+, Bun and Deno. Other runtimes inject their own `RandomBytes`. */
export const cryptoRandomBytes: RandomBytes = (bytes) => (globalThis as unknown as { crypto: CryptoLike }).crypto.getRandomValues(bytes)

export const mathRandomFraction: RandomFraction = () => Math.random()
