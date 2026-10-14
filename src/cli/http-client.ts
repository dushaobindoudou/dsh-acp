/**
 * Client half of this server's HTTP+SSE transport, as an SDK `Stream`:
 * `POST /acp` carries every client message (`initialize` answers inline and
 * mints the connection id), `GET /acp/stream` carries every server message,
 * `DELETE /acp` closes. Lets the CLI drive a RUNNING dsh (`serve`, or the
 * web composition's `/acp`) — where the GUI's sessions and workspaces live —
 * instead of cold-booting a private one per call.
 */
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

export interface HttpClientOptions {
  /** Server base URL (`http://127.0.0.1:3080`); `/acp` is appended. */
  readonly url: string
  readonly token?: string
  /** Transport failure (stream dropped, auth refused) — surfaced once. */
  readonly onError?: (error: Error) => void
}

/** Normalize a base URL to its `/acp` endpoint. */
export function acpEndpointOf(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  return trimmed.endsWith('/acp') ? trimmed : `${trimmed}/acp`
}

export function httpClientStream(options: HttpClientOptions): Stream & { close(): Promise<void> } {
  const endpoint = acpEndpointOf(options.url)
  const auth: Record<string, string> = options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}
  let connectionId: string | undefined
  let controller: ReadableStreamDefaultController<AnyMessage> | undefined
  const abort = new AbortController()
  let closed = false
  let failed = false

  const fail = (error: Error) => {
    if (closed || failed) return
    failed = true
    options.onError?.(error)
    try {
      controller?.error(error)
    } catch { /* already errored */ }
  }

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c
    },
  })

  async function pumpSse(id: string): Promise<void> {
    const response = await fetch(`${endpoint}/stream`, {
      headers: { accept: 'text/event-stream', 'acp-connection-id': id, ...auth },
      signal: abort.signal,
    })
    if (!response.ok || response.body === null) throw new Error(`ACP stream failed: HTTP ${response.status}`)
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data.length > 0) {
          try {
            controller?.enqueue(JSON.parse(data) as AnyMessage)
          } catch { /* a malformed frame is dropped, not fatal */ }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    if (!closed) throw new Error('ACP stream closed by the server')
  }

  async function write(message: AnyMessage): Promise<void> {
    if (closed) throw new Error('ACP HTTP connection is closed')
    if (connectionId === undefined) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(message),
        signal: abort.signal,
      })
      if (response.status === 401) throw new Error('ACP server refused the token (HTTP 401); pass --token / DSH_ACP_TOKEN')
      if (!response.ok) throw new Error(`ACP initialize failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
      const id = response.headers.get('acp-connection-id')
      if (id === null) throw new Error('ACP initialize response carried no Acp-Connection-Id')
      connectionId = id
      controller?.enqueue(await response.json() as AnyMessage)
      void pumpSse(id).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      return
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'acp-connection-id': connectionId, ...auth },
      body: JSON.stringify(message),
      signal: abort.signal,
    })
    if (!response.ok) {
      throw new Error(`ACP POST failed: HTTP ${response.status}`)
    }
  }

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      try {
        await write(message)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    },
  })

  return {
    readable,
    writable,
    async close() {
      if (closed) return
      closed = true
      abort.abort()
      const id = connectionId
      if (id !== undefined) {
        await fetch(endpoint, {
          method: 'DELETE',
          headers: { 'acp-connection-id': id, ...auth },
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined)
      }
      try {
        controller?.close()
      } catch { /* already closed or errored */ }
    },
  }
}
