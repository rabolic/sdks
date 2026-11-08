import { describe, expect, it } from 'vitest'
import { eventNameProblem, mergeProperties, sanitizeProperties, truncate } from '../src'

describe('sanitizeProperties', () => {
  it('drops prototype-polluting keys and never touches Object.prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "ok": 1}')
    const clean = sanitizeProperties(hostile)
    expect(clean).toEqual({ ok: 1 })
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const merged = mergeProperties({ a: 1 }, hostile as Record<string, unknown>)
    expect(Object.keys(merged)).toEqual(['a', 'ok'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('caps depth at 5 levels', () => {
    const issues: string[] = []
    const clean = sanitizeProperties({ l2: { l3: { l4: { l5: { keep: 1, l6: { gone: 1 } } } } } }, (issue) => issues.push(issue))
    expect(clean).toEqual({ l2: { l3: { l4: { l5: { keep: 1 } } } } })
    expect(issues.some((issue) => issue.includes('deeper'))).toBe(true)
  })

  it('caps keys per level at 255 and key length at 255', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < 300; i++) many[`k${i}`] = i
    many['x'.repeat(256)] = 1
    expect(Object.keys(sanitizeProperties(many)!)).toHaveLength(255)
    expect(sanitizeProperties({ ['y'.repeat(256)]: 1 })).toEqual({})
  })

  it('serializes like JSON.stringify: dates become strings, functions and undefined disappear', () => {
    const date = new Date('2026-11-08T10:00:00Z')
    const clean = sanitizeProperties({
      s: 's',
      n: 1.5,
      b: false,
      z: null,
      a: [1, undefined, () => 1],
      d: date,
      nan: Number.NaN,
      fn: () => 1,
      sym: Symbol('x'),
      u: undefined,
    })
    expect(clean).toEqual({ s: 's', n: 1.5, b: false, z: null, a: [1, null, null], d: '2026-11-08T10:00:00.000Z', nan: null })
  })

  it('drops unserializable properties (circular, BigInt) instead of throwing', () => {
    const issues: string[] = []
    const loop: Record<string, unknown> = { a: 1 }
    loop.self = loop
    expect(sanitizeProperties(loop, (issue) => issues.push(issue))).toBeUndefined()
    expect(sanitizeProperties({ big: BigInt(1) }, (issue) => issues.push(issue))).toBeUndefined()
    expect(issues).toHaveLength(2)
  })

  it('ignores non-objects', () => {
    expect(sanitizeProperties('nope')).toBeUndefined()
    expect(sanitizeProperties([1, 2])).toBeUndefined()
  })
})

describe('eventNameProblem', () => {
  it('accepts snake_case names and rejects reserved, empty, long and control-character names', () => {
    expect(eventNameProblem('signup_completed')).toBeUndefined()
    expect(eventNameProblem('$pageview')).toMatch(/reserved/)
    expect(eventNameProblem('$pageview', true)).toBeUndefined()
    expect(eventNameProblem('')).toBeDefined()
    expect(eventNameProblem('a'.repeat(201))).toBeDefined()
    expect(eventNameProblem('bad\nname')).toBeDefined()
    expect(eventNameProblem(42)).toBeDefined()
  })
})

describe('truncate', () => {
  it('does not split surrogate pairs', () => {
    expect(truncate('ab😀', 3)).toBe('ab')
    expect(truncate('abc', 5)).toBe('abc')
  })
})
