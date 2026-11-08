import { describe, expect, it } from 'vitest'
import { createEventQueue, MAX_EVENT_AGE_MS, MemoryStore, silentLogger } from '../src'
import { makeEvent, recordingLogger } from './helpers'

describe('EventQueue', () => {
  it('drops the oldest events when full', () => {
    const logger = recordingLogger()
    const queue = createEventQueue({ maxSize: 3, logger })
    const events = [1, 2, 3, 4, 5].map((i) => makeEvent(`e${i}`))
    events.forEach((event) => queue.enqueue(event, Date.now()))
    expect(queue.size).toBe(3)
    expect(queue.peekBatch(Date.now()).map((item) => item.event.event)).toEqual(['e3', 'e4', 'e5'])
    expect(logger.debugs.some((line) => line.includes('dropped 1 oldest'))).toBe(true)
  })

  it('drops events older than 7 days', () => {
    const queue = createEventQueue({ maxSize: 10, logger: silentLogger })
    const now = Date.now()
    queue.enqueue(makeEvent('old'), now - MAX_EVENT_AGE_MS - 1)
    queue.enqueue(makeEvent('new'), now)
    expect(queue.peekBatch(now).map((item) => item.event.event)).toEqual(['new'])
    expect(queue.size).toBe(1)
  })

  it('caps batches at 500 events', () => {
    const queue = createEventQueue({ maxSize: 1000, logger: silentLogger })
    for (let i = 0; i < 700; i++) queue.enqueue(makeEvent(), Date.now())
    expect(queue.peekBatch(Date.now())).toHaveLength(500)
  })

  it('persists through the store and restores in order', () => {
    const store = new MemoryStore()
    const first = createEventQueue({ maxSize: 10, store, storageKey: 'rb_queue', logger: silentLogger })
    const events = [makeEvent('a'), makeEvent('b')]
    events.forEach((event) => first.enqueue(event, Date.now()))
    const second = createEventQueue({ maxSize: 10, store, storageKey: 'rb_queue', logger: silentLogger })
    expect(second.peekBatch(Date.now()).map((item) => item.event)).toEqual(events)
    second.remove([events[0]!.event_id])
    const third = createEventQueue({ maxSize: 10, store, storageKey: 'rb_queue', logger: silentLogger })
    expect(third.size).toBe(1)
    third.clear()
    expect(store.get('rb_queue')).toBeNull()
  })

  it('ignores corrupt or hostile storage', () => {
    const store = new MemoryStore()
    for (const raw of ['not json', '{"v":2,"events":[]}', '{"v":1,"events":[null,1,{"e":{"event_id":"x"},"t":1}]}']) {
      store.set('rb_queue', raw)
      expect(createEventQueue({ maxSize: 10, store, storageKey: 'rb_queue', logger: silentLogger }).size).toBe(0)
    }
    const valid = makeEvent('ok')
    store.set('rb_queue', JSON.stringify({ v: 1, events: [{ e: valid, t: Date.now() }, { e: { ...valid, event_id: 'nope' }, t: 1 }] }))
    expect(createEventQueue({ maxSize: 10, store, storageKey: 'rb_queue', logger: silentLogger }).size).toBe(1)
  })
})
