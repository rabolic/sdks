import { fnv1a32, truncate, type CampaignContext, type ClickId } from '@rabolic/sdk-core'

const UTM_FIELDS: ReadonlyArray<[param: string, field: Exclude<keyof CampaignContext, 'click_id'>]> = [
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
  ['utm_campaign', 'name'],
  ['utm_content', 'content'],
  ['utm_term', 'term'],
]

const CLICK_IDS: readonly ClickId[] = ['gclid', 'fbclid', 'ttclid', 'msclkid']
const SHORT_TEXT = 512

export interface LandingCampaign {
  context: CampaignContext
  /** Identifies the parameter values, to detect a new campaign (protocol §4). Hashed so click ids are not stored. */
  signature: string
}

/** Reads utm and click-id parameters from a landing URL. `undefined` when there are none. */
export function parseCampaign(search: string): LandingCampaign | undefined {
  const params = new URLSearchParams(search)
  const context: CampaignContext = {}
  const seen: string[] = []
  for (const [param, field] of UTM_FIELDS) {
    const value = params.get(param)
    if (!value) continue
    context[field] = truncate(value, SHORT_TEXT)
    seen.push(`${param}=${value}`)
  }
  for (const clickId of CLICK_IDS) {
    const value = params.get(clickId)
    if (!value) continue
    context.click_id ??= clickId
    seen.push(`${clickId}=${value}`)
  }
  if (seen.length === 0) return undefined
  return { context, signature: fnv1a32(seen.join('&')).toString(16) }
}
