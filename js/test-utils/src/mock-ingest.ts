import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import type { SentBatch } from './fake-transport'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  /** Parsed JSON body (POST only). */
  body: unknown
  rawBody: string
}

export interface ScriptedResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** Wait this long before answering, to exercise client timeouts. */
  delayMs?: number
}

/**
 * A local ingest server implementing protocol §1: `POST /v1/batch` and
 * `GET /v1/config`. Answers come from `script` in order, then default to `200`
 * accepting everything. It sends CORS headers like the real ingest service.
 */
export class MockIngestServer {
  readonly requests: RecordedRequest[] = []
  readonly script: ScriptedResponse[] = []
  config: unknown = { enabled: true, sampleRate: 1 }
  configStatus = 200
  private server: Server | undefined

  get url(): string {
    const address = this.server?.address() as AddressInfo | null
    if (!address) throw new Error('server not started')
    return `http://127.0.0.1:${address.port}`
  }

  get batches(): SentBatch[] {
    return this.requests.filter((request) => request.method === 'POST').map((request) => request.body as SentBatch)
  }

  /** Events the server accepted (answered with 200), in arrival order. */
  readonly accepted: Array<Record<string, unknown>> = []

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '/'
    const rawBody = await readBody(request)
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After')

    let body: unknown
    try {
      body = rawBody ? (JSON.parse(rawBody) as unknown) : undefined
    } catch {
      body = undefined
    }
    this.requests.push({ method: request.method ?? '', path, headers: request.headers, body, rawBody })

    if (request.method === 'OPTIONS') return send(response, { status: 204 })
    if (request.method === 'GET' && path.startsWith('/v1/config')) {
      return send(response, { status: this.configStatus, body: this.configStatus === 200 ? this.config : { error: 'invalid_key' } })
    }
    if (request.method !== 'POST' || path !== '/v1/batch') return send(response, { status: 404 })

    const scripted = this.script.shift()
    if (scripted?.delayMs) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs))
    if (body === undefined) return send(response, { status: 400, body: { error: 'invalid_batch', message: 'body is not JSON' } })

    const events = ((body as { events?: unknown }).events ?? []) as Array<Record<string, unknown>>
    const answer = scripted ?? { status: 200, body: { accepted: events.length, rejected: [], dropped: 0 } }
    if (answer.status === 200) this.accepted.push(...events)
    send(response, answer)
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const buffer = Buffer.concat(chunks)
  return (request.headers['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString('utf8')
}

function send(response: ServerResponse, answer: ScriptedResponse): void {
  if (response.destroyed) return
  response.statusCode = answer.status
  for (const [name, value] of Object.entries(answer.headers ?? {})) response.setHeader(name, value)
  if (answer.body === undefined) {
    response.end()
    return
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(answer.body))
}
