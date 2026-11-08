import { describe, expect, it } from 'vitest'
import { fnv1a32, isSampledIn, isUuid, utf8Length, uuidv4, uuidv7, uuidv7Time } from '../src'

describe('ids', () => {
  it('uuidv4 has version 4 and the RFC variant', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv4()))
    expect(ids.size).toBe(1000)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('uuidv7 embeds the timestamp and sorts by time', () => {
    const t = Date.parse('2026-11-08T10:00:00.123Z')
    const id = uuidv7(t)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuidv7Time(id)).toBe(t)
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true)
    expect(isUuid(id)).toBe(true)
  })

  it('uses the injected secure random source, never Math.random', () => {
    const zeros = (bytes: Uint8Array) => bytes.fill(0)
    expect(uuidv4(zeros)).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('fnv1a32 matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
  })

  // Shared with the Flutter SDK (protocol §6): every SDK must sample the same devices.
  it.each([
    ['4f1c2a9e-7b3d-4c1e-9a2b-1d3e5f7a9b0c', 0x06d6c603],
    ['00000000-0000-4000-8000-000000000000', 0xd0703f35],
    ['ffffffff-ffff-4fff-bfff-ffffffffffff', 0x13ec198b],
    ['é😀', 0x039d63cc],
  ])('fnv1a32(%s) is the cross-SDK reference value', (id, expected) => {
    expect(fnv1a32(id)).toBe(expected)
  })

  it('sampling decisions match the reference values', () => {
    // 0x06d6c603 / 2^32 ≈ 0.0267; 0xd0703f35 / 2^32 ≈ 0.8142
    expect(isSampledIn('4f1c2a9e-7b3d-4c1e-9a2b-1d3e5f7a9b0c', 0.03)).toBe(true)
    expect(isSampledIn('4f1c2a9e-7b3d-4c1e-9a2b-1d3e5f7a9b0c', 0.02)).toBe(false)
    expect(isSampledIn('00000000-0000-4000-8000-000000000000', 0.82)).toBe(true)
    expect(isSampledIn('00000000-0000-4000-8000-000000000000', 0.81)).toBe(false)
  })

  it('utf8Length matches Buffer.byteLength', () => {
    for (const value of ['abc', 'é', '€', '😀', 'a\ud800b', 'mixed ü 😀 €']) {
      expect(utf8Length(value)).toBe(Buffer.byteLength(value))
    }
  })
})
