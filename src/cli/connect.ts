/**
 * How every CLI subcommand reaches a dsh ACP server: a RUNNING one over
 * HTTP (`--url` / `DSH_ACP_URL` — `serve`, or a web composition's `/acp`),
 * or a private `dsh --profile acp` child over stdio when no URL is given.
 * Either way the subcommand speaks plain ACP through the SDK client.
 */
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ClientApp, ClientContext } from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { httpClientStream } from './http-client.js'

export interface ServerTarget {
  /** Running server base URL; absent spawns a private stdio child. */
  readonly url?: string
  readonly token?: string
  /** Working directory of a spawned child. */
  readonly cwd: string
  /** Child command override (tests); default `$DSH_BIN/dsh --profile acp`. */
  readonly command?: readonly string[]
}

/** `--url` / `--token` with their environment fallbacks. */
export function targetOf(options: { url?: string; token?: string; cwd?: string }): ServerTarget {
  const url = options.url ?? nonEmpty(process.env.DSH_ACP_URL)
  const token = options.token ?? nonEmpty(process.env.DSH_ACP_TOKEN)
  return {
    cwd: options.cwd ?? process.cwd(),
    ...url !== undefined ? { url } : {},
    ...token !== undefined ? { token } : {},
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

export interface OpenedServer {
  readonly rpc: ClientContext
  /** Resolves when the transport dies (child exit, stream drop). */
  readonly lost: Promise<string>
  close(): Promise<void>
}

function childCommand(target: ServerTarget): readonly string[] {
  if (target.command !== undefined) return target.command
  const dsh = process.env.DSH_BIN ?? 'dsh'
  // Testing seam: extra launcher flags for the spawned server (e.g.
  // `--patch overlay.yml` for a mock LLM in e2e).
  const extra = (process.env.DSH_ACP_RUN_ARGS ?? '').split(' ').filter((part) => part.length > 0)
  return [dsh, '--profile', 'acp', ...extra]
}

/**
 * Connect, run `initialize` (+ the no-op `authenticate`), and hand back the
 * request context. `configure` registers the subcommand's client handlers
 * (session updates, permission/elicitation answers, vendor notifications).
 */
export async function openServer(
  target: ServerTarget,
  configure: (app: ClientApp) => ClientApp,
  clientCapabilities: Record<string, unknown> = {},
): Promise<OpenedServer> {
  const app = configure(client({ name: 'dsh-acp-cli' }))
  let lostReason: string | undefined
  let markLost: (reason: string) => void = () => undefined
  const lost = new Promise<string>((resolve) => {
    markLost = (reason) => {
      if (lostReason !== undefined) return
      lostReason = reason
      resolve(reason)
    }
  })

  let closeTransport: () => Promise<void>
  let connection: ReturnType<ClientApp['connect']>
  if (target.url !== undefined) {
    const stream = httpClientStream({
      url: target.url,
      ...target.token !== undefined ? { token: target.token } : {},
      onError: (error) => markLost(error.message),
    })
    connection = app.connect(stream)
    closeTransport = () => stream.close()
  } else {
    const command = childCommand(target)
    const child = spawn(command[0]!, command.slice(1), { cwd: target.cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()))
    child.on('error', (error) => markLost(String(error)))
    void exited.then(() => markLost('the dsh process exited'))
    connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ))
    closeTransport = async () => {
      child.stdin.end()
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killer.unref()
      await exited
      clearTimeout(killer)
    }
  }
  const rpc = connection.agent
  const opened: OpenedServer = {
    rpc,
    lost,
    async close() {
      connection.close()
      await closeTransport()
    },
  }
  try {
    await settle(opened, rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities,
    }), 'initialize')
    // Strict-client handshake step; the server answers with a no-op.
    await settle(opened, rpc.request('authenticate', { methodId: 'none' }).catch(() => undefined) as Promise<unknown>, 'authenticate')
  } catch (error) {
    await opened.close().catch(() => undefined)
    throw error
  }
  return opened
}

/** Race a request against transport loss so a dead server never hangs the CLI. */
export function settle<T>(server: OpenedServer, promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    server.lost.then((reason) => { throw new Error(`${reason} before ${what} completed`) }),
  ])
}

/** A JSON-RPC error as one printable line plus its structured data. */
export function describeRpcError(error: unknown): { message: string; code?: number; data?: unknown } {
  if (error !== null && typeof error === 'object') {
    const record = error as { message?: unknown; code?: unknown; data?: unknown }
    return {
      message: typeof record.message === 'string' ? record.message : String(error),
      ...typeof record.code === 'number' ? { code: record.code } : {},
      ...record.data !== undefined ? { data: record.data } : {},
    }
  }
  return { message: String(error) }
}
