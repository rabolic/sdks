import { describe, expect, it } from 'vitest'
import { createRabolic } from '../src'
import { fakeIngest, openPage, sentEvents } from './helpers'

/**
 * The install code the dashboard shows (apps/dashboard/.../snippets.ts), run as
 * written. If this stops compiling, the snippets need updating too.
 */
describe('dashboard install snippets', () => {
  it('onboarding and integrations snippets work as shown', async () => {
    const page = openPage()
    const fake = fakeIngest()
    const rabolic = createRabolic({ window: page.win, transport: fake.transport })
    const user = { id: 'usr_8f2k1x9q' }

    rabolic.init({ projectKey: 'rb_pub_8fK2Qm', trackRoutes: true })
    rabolic.identify(user.id)
    rabolic.track('signup_completed', { method: 'google' })
    rabolic.track('checkout_started', { plan: 'pro_annual', price: 79.99 })
    rabolic.identify('usr_8f2k1x9q', { plan: 'pro', account_created_at: '2026-10-25' })
    await rabolic.flush()

    expect(sentEvents(fake).map((event) => event.event)).toEqual([
      '$pageview',
      '$identify',
      'signup_completed',
      'checkout_started',
      '$identify',
    ])
    await page.close()
  })
})
