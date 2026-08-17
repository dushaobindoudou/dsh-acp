/**
 * dsh-acp: an Agent Client Protocol (ACP) v1 server as a dsh profile bundle.
 *
 * The plugin owns the process stdio: ACP NDJSON JSON-RPC on stdin/stdout,
 * logs on stderr, no other writer may touch stdout. It rides directly over
 * `dsh-base` (agents, sessions, persistence, approval, tools) - see
 * cordis.patch.yml and README.md.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Readable, Writable } from 'node:stream'
import type { AgentConnection } from '@agentclientprotocol/sdk'
import { buildAcpApp, connectStdio } from './connection.js'
import { AcpSessionTable } from './table.js'

export const name = 'acp-server'

/** Hard dependencies: the agent registry and the default-model selection. */
export const inject = ['agents', 'agentDefaultModel']

import { Config, modelSelectionOf, validateModelPin } from './config.js'
export { Config }
export type { Config as AcpServerConfig } from './config.js'
import { SERVE_STARTUP_SERVICE, type ServeOptions } from './serve-startup.js'
export { SERVE_STARTUP_SERVICE } from './serve-startup.js'
export type { ServeOptions } from './serve-startup.js'
import { startServeTransport } from './http-transport.js'

/** Process seams, overridable from tests (mirrors dsh-headless's `internals`). */
export const internals: {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
} = {
  stdin: process.stdin,
  stdout: process.stdout,
}

type AppExit = (code: number) => void

const VERSION = '0.1.0'

export async function apply(ctx: Context, config: Config): Promise<void> {
  validateModelPin(config) // both-or-neither, fails the plugin loudly at load
  const exit = ctx.get('appExit') as AppExit | undefined
  if (exit === undefined) {
    throw new Error('acp-server: the launcher must provide ctx.appExit before the tree mounts (boot via `dsh --profile acp`)')
  }
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
  if (agents === undefined || defaultModel === undefined) return // inject guarantees these; runtime double-check

  const table = new AcpSessionTable()
  const log = (message: string) => {
    // Logs go to stderr only; stdout is reserved for ACP frames.
    process.stderr.write(`dsh-acp: ${message}\n`)
  }

  const app = buildAcpApp({
    ctx,
    agents,
    modelSelection: modelSelectionOf(config, defaultModel.currentSelection()),
    offerAlwaysPermissions: config.offerAlwaysPermissions,
    flushOnTurnEnd: config.flushOnTurnEnd,
    table,
    log,
    agentName: config.agentName,
    version: VERSION,
  })

  const stdin = internals.stdin as Readable
  const stdout = internals.stdout as Writable

  // Serve mode: `dsh --profile acp serve` publishes acpServeStartup and the
  // process becomes a long-lived HTTP+SSE ACP endpoint instead of a stdio
  // child. The publish happens in the serve-startup row, which mounts before
  // this row in cordis.patch.yml.
  const serveOptions = ctx.get(SERVE_STARTUP_SERVICE) as ServeOptions | undefined
  if (serveOptions !== undefined) {
    const handle = await startServeTransport(app, serveOptions, (message) => {
      log(`serve: ${message}`)
    })
    log(`serve listening on http://${serveOptions.host}:${handle.port}${serveOptions.token !== undefined ? ' (bearer auth on)' : ''}`)
    let serveClosed = false
    ctx.effect(() => {
      return () => {
        if (serveClosed) return
        serveClosed = true
        void handle.close().finally(() => exit(0))
      }
    })
    // A serve process is closed by its operator (SIGINT/SIGTERM), not by
    // stdin: editors never attach one. Leave stdio untouched.
    return
  }

  const connection: AgentConnection = connectStdio(
    app,
    Readable.toWeb(stdin) as unknown as ReadableStream<Uint8Array>,
    Writable.toWeb(stdout) as unknown as WritableStream<Uint8Array>,
  )

  let closed = false
  const shutdown = (code: number) => {
    if (closed) return
    closed = true
    connection.close()
    void table.disposeAll().finally(() => exit(code))
  }

  ctx.effect(() => {
    // Plugin unload (profile teardown) takes the connection down with it.
    return () => shutdown(0)
  })

  stdin.on('end', () => shutdown(0))
  stdin.on('close', () => shutdown(0))
  stdin.on('error', (error) => {
    log(`stdin error: ${String(error)}`)
    shutdown(1)
  })
  process.on('SIGPIPE', () => {
    // The client went away; stdout writes failing are expected then.
  })
}

export default { name, inject, Config, apply, internals }
