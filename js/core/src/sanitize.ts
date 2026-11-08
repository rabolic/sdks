import type { JsonObject, JsonValue } from './types'

/** Size limits from protocol §2. */
export const MAX_KEYS_PER_LEVEL = 255
/** The properties object itself is level 1. */
export const MAX_DEPTH = 5
export const MAX_KEY_LENGTH = 255
export const MAX_EVENT_BYTES = 32_768
export const MAX_EVENT_NAME_LENGTH = 200
export const MAX_USER_ID_LENGTH = 255
export const MAX_ANONYMOUS_ID_LENGTH = 128

/** Keys that could reach `Object.prototype` if a consumer merges our objects naively. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type IssueReporter = (message: string) => void

/**
 * Turns caller-supplied properties into a JSON object within the protocol
 * limits. Values are serialized as `JSON.stringify` does (dates become strings,
 * functions and `undefined` disappear); then depth, key count, key length and
 * prototype-polluting keys are enforced. Problems are reported, never thrown.
 */
export function sanitizeProperties(input: unknown, report: IssueReporter = () => {}): JsonObject | undefined {
  if (input === undefined || input === null) return undefined
  if (!isPlainObject(input)) {
    report('properties must be a plain object')
    return undefined
  }
  let json: unknown
  try {
    json = JSON.parse(JSON.stringify(input))
  } catch {
    report('properties are not serializable')
    return undefined
  }
  return limitValue(json, 1, 'properties', report) as JsonObject
}

/** `JSON.parse` output only: plain objects, arrays and primitives. */
function limitValue(value: unknown, depth: number, path: string, report: IssueReporter): JsonValue | undefined {
  if (typeof value !== 'object' || value === null) return value as JsonValue
  if (depth > MAX_DEPTH) {
    report(`dropped ${path}: deeper than ${MAX_DEPTH} levels`)
    return undefined
  }
  if (Array.isArray(value)) return value.map((item, index) => limitValue(item, depth + 1, `${path}[${index}]`, report) ?? null)
  const output: JsonObject = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || key.length > MAX_KEY_LENGTH) {
      report(`dropped ${path}.${key.slice(0, 40)}: unsafe or too long key`)
    } else if (count === MAX_KEYS_PER_LEVEL) {
      report(`dropped keys over ${MAX_KEYS_PER_LEVEL} in ${path}`)
      break
    } else {
      const clean = limitValue(item, depth + 1, `${path}.${key}`, report)
      if (clean !== undefined) {
        output[key] = clean
        count++
      }
    }
  }
  return output
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Shallow merge of own keys, later sources winning, skipping keys that could pollute prototypes. */
export function mergeProperties(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const source of sources) {
    if (!source) continue
    for (const key of Object.keys(source)) {
      if (!UNSAFE_KEYS.has(key)) merged[key] = source[key]
    }
  }
  return merged
}

/** 1–200 code points, no control characters (C0 or DEL): the schema's rule for `event`. */
const EVENT_NAME = /^[^\u0000-\u001f\u007f]{1,200}$/u

/** Returns why `name` is not a valid event name, or `undefined` when it is. */
export function eventNameProblem(name: unknown, allowReserved = false): string | undefined {
  if (typeof name !== 'string' || !EVENT_NAME.test(name)) return `name must be 1-${MAX_EVENT_NAME_LENGTH} characters, no control characters`
  if (!allowReserved && name.startsWith('$')) return '$ names are reserved'
  return undefined
}

/** Returns why `id` is not a valid id of at most `maxLength` characters, or `undefined`. */
export function idProblem(id: unknown, label: string, maxLength: number): string | undefined {
  if (typeof id !== 'string' || id.length === 0) return `${label} must be a non-empty string`
  if (id.length > maxLength) return `${label} over ${maxLength} characters`
  return undefined
}

/** Cuts `value` to `maxLength` UTF-16 code units, without splitting a surrogate pair. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const code = value.charCodeAt(maxLength - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength
  return value.slice(0, end)
}
