/**
 * The setup check: one `rabolic_cli_check` event sent with the project's key,
 * so the developer sees it arrive on the Live page before writing any code.
 */
import { randomUUID } from 'node:crypto'
import type { KeyKind } from './plan'
import { VERSION } from './version'

export interface CheckResult {
  ok: boolean
  message: string
}

export async function sendCheck(key: string, kind: KeyKind, host: string, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  const anonymousId = `cli-${randomUUID()}`
  const event = {
    event_id: randomUUID(),
    type: 'track',
    event: 'rabolic_cli_check',
    timestamp: new Date().toISOString(),
    anonymous_id: anonymousId,
    properties: { cli_version: VERSION },
    // An empty user agent: ingest reads the browser from it, and this isn't a browser (nor a bot).
    context: kind === 'publishable' ? { platform: 'web', user_agent: '' } : {},
  }
  let res: Response
  try {
    res = await fetchImpl(`${host.replace(/\/+$/, '')}/v1/batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sent_at: new Date().toISOString(), library: { name: 'http', version: `rabolic-cli ${VERSION}` }, events: [event] }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    return { ok: false, message: `Couldn't reach ${host}: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'The key was refused. Copy it again from Integrations → Keys in Rabolic.' }
  if (res.status === 402) return { ok: false, message: 'The organization can’t take events right now (trial over or plan ended). See Billing in Rabolic.' }
  if (!res.ok) return { ok: false, message: `Ingest answered ${res.status}. Try again in a minute.` }
  const body = (await res.json().catch(() => null)) as { accepted?: number; rejected?: { reason?: string }[]; dropped?: number } | null
  if (body?.accepted === 1) return { ok: true, message: 'Rabolic received a test event (rabolic_cli_check). Open Live in your project to see it.' }
  const reason = body?.rejected?.[0]?.reason
  return { ok: false, message: reason ? `The test event was rejected: ${reason}.` : body?.dropped ? 'The test event was dropped (the organization is over its limit).' : 'The test event wasn’t accepted.' }
}
