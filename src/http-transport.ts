/**
 * ACP over HTTP+SSE, following the shape of the ACP "Streamable HTTP &
 * WebSocket Transport" RFD (draft): POST carries client->server JSON-RPC
 * messages, a long-lived SSE GET stream carries all server->client messages,
 * and `Acp-Connection-Id` binds them. Each HTTP connection drives one SDK
 * AgentConnection over in-memory streams.
 *
 * The router below is transport-agnostic. It is served two ways:
 *  - standalone `serve` mode: its own node:http server (src/index.ts)
 *  - web-mounted mode: registered onto the shared `webServer` service of a
 *    web composition, so the GUI and ACP share one process and one port
 *
 *   POST   /acp           one JSON-RPC message per request body
 *                          `initialize` -> 200 + JSON body + Acp-Connection-Id
 *                          everything else (requests AND responses to
 *                          server-initiated requests like
 *                          session/request_permission) -> 202 Accepted
 *   GET    /acp/stream     SSE stream for the connection (header or query)
 *   DELETE /acp            close the connection
 *   GET    /acp/healthz    liveness probe (no auth)
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { AgentApp, AgentConnection } from '@agentclientprotocol/sdk'
import { trackConnection } from './connections.js'

/**
 * How long a connection survives without any attached SSE stream before it
 * is closed (and its sessions released). EventSource clients reconnect
 * within this window after a network blip; a killed client never does.
 */
const ORPHAN_GRACE_MS = 30_000

export interface AcpHttpOptions {
  readonly token: string | undefined
  /** Serve the built-in single-file web client at GET / (standalone serve
   * mode only - a web composition already has the real GUI on that path). */
  readonly serveUi: boolean
}

export interface AcpRouter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): void
}

const encoder = new TextEncoder()

export function createAcpRouter(app: AgentApp, opts: AcpHttpOptions, log: (message: string) => void): AcpRouter {
  const connections = new Map<string, AcpHttpConnection>()
  let uiCache: string | undefined
  const webUi = (): string => {
    uiCache ??= readFileSync(new URL('../webui.html', import.meta.url), 'utf8')
    return uiCache
  }

  interface AcpHttpConnection {
    readonly id: string
    readonly conn: AgentConnection
    receive(message: unknown): void
    attachStream(res: ServerResponse): void
    /** A per-session SSE stream (SDK HTTP client shape): kept open, idle. */
    attachSessionStream(res: ServerResponse): void
    close(): void
  }

  function makeConnection(initializeId: number | string): { connection: AcpHttpConnection; initializeResult: Promise<unknown> } {
    const id = randomUUID()
    let inputController: ReadableStreamDefaultController<Uint8Array> | undefined
    let sse: ServerResponse | undefined
    const pending: string[] = []
    let initializeResolve: ((value: unknown) => void) | undefined

    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller
      },
    })
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        // ndJsonStream writes one serialized JSON-RPC frame per call.
        const frame = new TextDecoder().decode(chunk).trim()
        if (frame === '') return
        let parsed: { id?: number | string }
        try {
          parsed = JSON.parse(frame) as { id?: number | string }
        } catch {
          return
        }
        if (initializeResolve !== undefined && parsed.id === initializeId) {
          const resolve = initializeResolve
          initializeResolve = undefined
          resolve(JSON.parse(frame))
          return
        }
        if (sse !== undefined && !sse.writableEnded) sse.write(`data: ${frame}\n\n`)
        else pending.push(frame)
      },
    })

    const conn = app.connect(ndJsonStream(output, input))
    trackConnection(conn)
    const sideStreams = new Set<ServerResponse>()
    let orphanTimer: ReturnType<typeof setTimeout> | undefined
    const armOrphanTimer = () => {
      clearTimeout(orphanTimer)
      orphanTimer = setTimeout(() => {
        if (sse !== undefined && !sse.writableEnded && !sse.destroyed) return
        log(`connection ${id.slice(0, 8)} lost its stream; closing it`)
        connection.close()
      }, ORPHAN_GRACE_MS)
      orphanTimer.unref?.()
    }
    const openSse = (res: ServerResponse) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-acp-connection-id': id,
      })
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 15_000)
      res.on('close', () => clearInterval(heartbeat))
    }
    const connection: AcpHttpConnection = {
      id,
      conn,
      receive(message) {
        inputController?.enqueue(encoder.encode(`${JSON.stringify(message)}\n`))
      },
      attachStream(res) {
        clearTimeout(orphanTimer)
        sse = res
        openSse(res)
        for (const frame of pending) res.write(`data: ${frame}\n\n`)
        pending.length = 0
        res.on('close', () => {
          if (sse === res) armOrphanTimer()
        })
      },
      attachSessionStream(res) {
        // Every server message rides the connection stream; the session
        // stream exists so the SDK client's per-session bookkeeping opens.
        sideStreams.add(res)
        openSse(res)
        res.on('close', () => sideStreams.delete(res))
      },
      close() {
        try {
          conn.close()
        } catch {
          // Already closed.
        }
        try {
          inputController?.close()
        } catch {
          // Already closed.
        }
        if (sse !== undefined && !sse.writableEnded) sse.end()
        for (const side of sideStreams) if (!side.writableEnded) side.end()
        sideStreams.clear()
        clearTimeout(orphanTimer)
        connections.delete(id)
      },
    }
    connections.set(id, connection)
    // A client that initializes but never opens its stream is orphaned too.
    armOrphanTimer()
    const initializeResult = new Promise<unknown>((resolve) => {
      initializeResolve = resolve
    })
    return { connection, initializeResult }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    if (opts.serveUi && method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(webUi())
      return
    }

    if (method === 'GET' && (url.pathname === '/acp/healthz' || url.pathname === '/healthz')) {
      res.writeHead(200).end('ok')
      return
    }

    if (opts.token !== undefined) {
      const provided = req.headers.authorization ?? ''
      if (provided !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorized')
        return
      }
    }

    if (method === 'POST' && url.pathname === '/acp') {
      const body = await readBody(req)
      const messages = parseMessages(body)
      if (messages.length === 0) {
        res.writeHead(400).end('expected a JSON-RPC message')
        return
      }
      const first = messages[0] as { method?: string; id?: number | string }
      if (first.method === 'initialize') {
        const { connection, initializeResult } = makeConnection(first.id ?? 0)
        connection.receive(first)
        for (const message of messages.slice(1)) connection.receive(message)
        const result = await withTimeout(initializeResult, 10_000, 'initialize response')
        res.writeHead(200, {
          'content-type': 'application/json',
          'acp-connection-id': connection.id,
        })
        res.end(JSON.stringify(result))
        log(`connection ${connection.id.slice(0, 8)} initialized`)
        return
      }
      const connectionId = String(req.headers['acp-connection-id'] ?? url.searchParams.get('connection') ?? '')
      const connection = connections.get(connectionId)
      if (connection === undefined) {
        res.writeHead(404).end('unknown Acp-Connection-Id (initialize first)')
        return
      }
      for (const message of messages) connection.receive(message)
      res.writeHead(202).end()
      return
    }

    // `GET /acp/stream` is this server's original stream route; `GET /acp`
    // (Accept: text/event-stream) is the SDK HTTP client's shape for the
    // same connection stream, plus one per session (`Acp-Session-Id`).
    if (method === 'GET' && (url.pathname === '/acp/stream' || url.pathname === '/acp')) {
      const connectionId = String(req.headers['acp-connection-id'] ?? url.searchParams.get('connection') ?? '')
      const connection = connections.get(connectionId)
      if (connection === undefined) {
        res.writeHead(404).end('unknown Acp-Connection-Id')
        return
      }
      if (url.pathname === '/acp' && req.headers['acp-session-id'] !== undefined) connection.attachSessionStream(res)
      else connection.attachStream(res)
      return
    }

    if (method === 'DELETE' && url.pathname === '/acp') {
      const connectionId = String(req.headers['acp-connection-id'] ?? url.searchParams.get('connection') ?? '')
      const connection = connections.get(connectionId)
      if (connection === undefined) {
        res.writeHead(404).end('unknown Acp-Connection-Id')
        return
      }
      connection.close()
      res.writeHead(204).end()
      return
    }

    res.writeHead(404).end('see POST /acp, GET /acp/stream, DELETE /acp')
  }

  return {
    handle,
    close() {
      for (const connection of connections.values()) connection.close()
      connections.clear()
    },
  }
}

export interface ServeHandle {
  readonly port: number
  close(): Promise<void>
}

/** Standalone `serve` mode: the router on its own node:http server. */
export function startServeTransport(
  app: AgentApp,
  opts: { host: string; port: number; token: string | undefined },
  log: (message: string) => void,
): Promise<ServeHandle> {
  const router = createAcpRouter(app, { token: opts.token, serveUi: true }, log)
  const server: Server = createServer((req, res) => {
    void router.handle(req, res).catch((error: unknown) => {
      log(`http handler failed: ${String(error instanceof Error ? error.message : error)}`)
      if (!res.writableEnded) res.writeHead(500).end()
    })
  })
  return new Promise<ServeHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : opts.port
      server.removeAllListeners('error')
      server.on('error', (error) => log(`serve socket error: ${String(error)}`))
      resolve({
        port,
        async close() {
          router.close()
          await new Promise<void>((done) => server.close(() => done()))
        },
      })
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Accept a single JSON object or NDJSON lines. */
function parseMessages(body: string): unknown[] {
  const text = body.trim()
  if (text === '') return []
  if (text.startsWith('{')) {
    try {
      return [JSON.parse(text)]
    } catch {
      // Fall through to line parsing.
    }
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return undefined
      }
    })
    .filter((message): message is Record<string, unknown> => message !== undefined)
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)),
  ])
}
