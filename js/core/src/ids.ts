import { cryptoRandomBytes, type RandomBytes } from './platform'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')
}

/** Sets the version nibble and the RFC 9562 variant bits in place. */
export function stampUuid(bytes: Uint8Array, version: number): Uint8Array {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | (version << 4)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return bytes
}

/** Random UUIDv4, used for `anonymous_id`. */
export function uuidv4(random: RandomBytes = cryptoRandomBytes): string {
  return formatUuid(stampUuid(random(new Uint8Array(16)), 4))
}

/** UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits. Used for `event_id` and `session_id`. */
export function uuidv7(nowMs: number, random: RandomBytes = cryptoRandomBytes): string {
  const randomPart = formatUuid(stampUuid(random(new Uint8Array(16)), 7))
  const time = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, '0')
  return `${time.slice(0, 8)}-${time.slice(8)}${randomPart.slice(13)}`
}

/** The Unix milliseconds embedded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}

interface TextEncoderLike {
  encode(value: string): Uint8Array
}

let encoder: TextEncoderLike | undefined

function getEncoder(): TextEncoderLike {
  encoder ??= new (globalThis as unknown as { TextEncoder: new () => TextEncoderLike }).TextEncoder()
  return encoder
}

/** Length of `value` in UTF-8 bytes: the size that counts against the protocol limits. */
export function utf8Length(value: string): number {
  return getEncoder().encode(value).length
}

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `value`. Stable across runtimes, which
 * is what sampling needs (protocol §6: `hash(anonymous_id) / 2^32`).
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of getEncoder().encode(value)) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}
