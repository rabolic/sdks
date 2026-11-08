/** Structural copies of the core transport types, so this package does not depend on core. */
export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  signal?: unknown
}

export interface HttpResponse {
  status: number
  body: string
  retryAfter: string | null
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>

export interface SentEvent extends Record<string, unknown> {
  event: string
  event_id: string
}

export interface SentBatch extends Record<string, unknown> {
  sent_at: string
  key?: string
  events: SentEvent[]
}

export interface PendingCall {
  request: HttpRequest
  /** Parsed JSON body, when there is one. */
  body: unknown
  respond(status: number, body?: unknown, retryAfter?: string): void
  fail(error?: unknown): void
}

/**
 * A transport whose responses the test decides. With `autoRespond`, every call
 * is answered at once; otherwise calls wait in `pending` until answered.
 */
export class FakeTransport {
  readonly calls: PendingCall[] = []
  readonly pending: PendingCall[] = []
  maxConcurrent = 0
  autoRespond: ((call: PendingCall) => void) | undefined

  readonly transport: Transport = (request) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const settle = (): void => {
        const index = this.pending.indexOf(call)
        if (index >= 0) this.pending.splice(index, 1)
      }
      const call: PendingCall = {
        request,
        body: request.body ? (JSON.parse(request.body) as unknown) : undefined,
        respond: (status, body, retryAfter) => {
          settle()
          resolve({
            status,
            body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
            retryAfter: retryAfter ?? null,
          })
        },
        fail: (error) => {
          settle()
          reject(error ?? new Error('network error'))
        },
      }
      this.calls.push(call)
      this.pending.push(call)
      this.maxConcurrent = Math.max(this.maxConcurrent, this.batchCallsPending())
      this.autoRespond?.(call)
    })

  /** Batch requests sent so far, as parsed envelopes. */
  get batches(): SentBatch[] {
    return this.calls.filter((call) => call.request.method === 'POST').map((call) => call.body as SentBatch)
  }

  /** Answers the oldest pending call. */
  respondNext(status: number, body?: unknown, retryAfter?: string): void {
    const call = this.pending[0]
    if (!call) throw new Error('no pending request')
    call.respond(status, body, retryAfter)
  }

  private batchCallsPending(): number {
    return this.pending.filter((call) => call.request.method === 'POST').length
  }
}

/** A `200` body accepting every event of the call. */
export function acceptAll(call: PendingCall): { accepted: number; rejected: never[]; dropped: number } {
  const events = (call.body as { events?: unknown[] } | undefined)?.events ?? []
  return { accepted: events.length, rejected: [], dropped: 0 }
}
