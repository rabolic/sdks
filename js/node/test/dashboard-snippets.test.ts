import { acceptAll, FakeTransport } from '@rabolic/test-utils'
import { describe, expect, it } from 'vitest'
import { Rabolic } from '../src'

/** The Node snippet from the dashboard's Integrations page, run as written. */
describe('dashboard install snippet', () => {
  it('works as shown', async () => {
    process.env.RABOLIC_SECRET_KEY ??= 'rb_test_snippet'
    const invoice = { id: 'in_123' }
    const fake = new FakeTransport()
    fake.autoRespond = (call) => call.respond(200, acceptAll(call))

    const rabolic = new Rabolic({ secretKey: process.env.RABOLIC_SECRET_KEY }, { transport: fake.transport })

    await rabolic.track({
      userId: 'usr_8f2k1x9q',
      event: 'subscription_renewed',
      properties: { amount: 9.99, currency: 'USD' },
      idempotencyKey: invoice.id,
    })
    await rabolic.shutdown()
    expect(fake.batches[0]?.events.map((event) => event.event)).toEqual(['subscription_renewed'])
  })
})
