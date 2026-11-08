import type { Timers } from './platform'

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  /** An `AbortSignal` when the runtime has one. Aborted on timeout. */
  signal?: unknown
}

export interface HttpResponse {
  status: number
  body: string
  /** Raw `Retry-After` header, if any. */
  retryAfter: string | null
}

/** Sends one HTTP request. Rejects on network errors; any HTTP status resolves. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>

interface FetchResponseLike {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>

/** A transport on the global `fetch` (browsers, Node 20+, React Native, Bun, Deno). */
export function fetchTransport(extraInit: Record<string, unknown> = {}): Transport {
  return async (request) => {
    const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch
    if (!fetchImpl) throw new Error('no fetch')
    const response = await fetchImpl(request.url, {
      ...extraInit,
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })
    const body = await response.text().catch(() => '')
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') }
  }
}

interface AbortControllerLike {
  signal: unknown
  abort(): void
}

/** Runs `request` with a deadline, aborting the underlying request when the runtime supports it. */
export function sendWithTimeout(
  transport: Transport,
  request: HttpRequest,
  timeoutMs: number,
  timers: Timers,
): Promise<HttpResponse> {
  const Controller = (globalThis as { AbortController?: new () => AbortControllerLike }).AbortController
  const controller = Controller ? new Controller() : undefined
  return new Promise<HttpResponse>((resolve, reject) => {
    const timer = timers.setTimeout(() => {
      controller?.abort()
      reject(new Error('timeout'))
    }, timeoutMs)
    transport({ ...request, signal: controller?.signal }).then(
      (response) => {
        timers.clearTimeout(timer)
        resolve(response)
      },
      (error: unknown) => {
        timers.clearTimeout(timer)
        reject(error)
      },
    )
  })
}
