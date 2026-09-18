/**
 * dsh-acp: an Agent Client Protocol (ACP) v1 server as a dsh profile bundle.
 *
 * Three transports, chosen deterministically at mount:
 *
 *  - serve (`dsh --profile acp serve`): a standalone HTTP+SSE endpoint.
 *  - web-mounted (inside a web composition): the ACP routes ride the shared
 *    `webServer` service, so `dsh web` serves the GUI and /acp on ONE port.
 *  - stdio (default): ACP NDJSON JSON-RPC on stdin/stdout for editors; logs
 *    on stderr, no other writer may touch stdout.
 *
 * It rides directly over `dsh-base` (agents, sessions, persistence,
 * approval, tools) - see cordis.patch.yml and README.md.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import type { AgentConnection } from '@agentclientprotocol/sdk'
import { buildAcpApp, connectStdio } from './connection.js'
import { notifyDshChanged } from './dsh-extensions.js'
import { translateSessionEventAll } from './event-bridge.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { dispatchGlobalSessionEvent, setWatchTranslator } from './watch.js'
import { AcpSessionTable } from './table.js'
import { IMAGE_MEDIA_TYPES } from './translate.js'

export const name = 'acp-server'

/** Hard dependencies: the agent registry and the default-model selection. */
export const inject = ['agents', 'agentDefaultModel']

import { Config, modelSelectionOf, validateModelPin } from './config.js'
export { Config }
export type { Config as AcpServerConfig } from './config.js'
import { SERVE_STARTUP_SERVICE, type ServeOptions } from './serve-startup.js'
export { SERVE_STARTUP_SERVICE } from './serve-startup.js'
export type { ServeOptions } from './serve-startup.js'
import { startServeTransport, createAcpRouter } from './http-transport.js'

/** Process seams, overridable from tests (mirrors dsh-headless's `internals`). */
export const internals: {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.ReadableStream & NodeJS.WritableStream
} = {
  stdin: process.stdin,
  stdout: process.stdout,
}

type AppExit = (code: number) => void

/** The shared HTTP service of a web composition (@deepseek-ai/dsh-host-webserver). */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
}

/** How long stdin EOF waits for a late web composition before exiting. */
const WEB_GRACE_MS = 2_000

// agentInfo.version tracks the real package version instead of a hardcoded
// string that silently drifted (was '0.1.0' while the package is 0.11.x).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const VERSION: string = require('../package.json').version

/** The slice of the jobs service the dsh/changed signal needs. */
interface JobsSignal {
  onJobsChanged(listener: () => void): () => void
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  validateModelPin(config) // both-or-neither, fails the plugin loudly at load
  const exit = ctx.get('appExit') as AppExit | undefined
  if (exit === undefined) {
    throw new Error('acp-server: the launcher must provide ctx.appExit before the tree mounts (boot via `dsh --profile acp`)')
  }
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
  if (agents === undefined || defaultModel === undefined) return // inject guarantees these; runtime double-check
  const serveOptions = ctx.get(SERVE_STARTUP_SERVICE) as ServeOptions | undefined

  const table = new AcpSessionTable()
  const log = (message: string) => {
    // Logs go to stderr only; stdout is reserved for ACP frames.
    process.stderr.write(`dsh-acp: ${message}\n`)
  }

  const app = buildAcpApp({
    ctx,
    agents,
    modelSelection: () => modelSelectionOf(config, defaultModel.currentSelection()),
    imageCapability: async () => {
      // Mirror the official dsh-acp capability gate: attachments must accept an
      // ACP image media type and the default model route must declare image
      // input. Any doubt resolves to false — over-advertising turns into
      // client-visible upload failures at the model-call stage.
      type AttachmentsLike = { imageLimits?: { mediaTypes?: readonly string[] } }
      const attachments = ctx.get('attachments') as AttachmentsLike | undefined
      const mediaTypes = attachments?.imageLimits?.mediaTypes
      if (mediaTypes === undefined || !mediaTypes.some((t) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(t))) {
        return false
      }
      const llm = ctx.get('llm') as
        | { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> }
        | undefined
      if (llm === undefined) return false
      const { provider, model } = defaultModel.currentSelection()
      try {
        const info = await llm.resolveModelInfo(provider, model)
        return info.inputModalities?.includes('image') === true
      } catch {
        return false
      }
    },
    offerAlwaysPermissions: config.offerAlwaysPermissions,
    flushOnTurnEnd: config.flushOnTurnEnd,
    table,
    log,
    dshServices: () => ({
      sessionQuery: ctx.get('sessionQuery'),
      jobs: ctx.get('jobs'),
      goals: ctx.get('goals'),
      skills: ctx.get('skills'),
      agents: ctx.get('agents'),
      planMode: ctx.get('planMode'),
      commands: ctx.get('commands'),
    }),
    attachments: () => ctx.get('attachments'),
    agentName: config.agentName,
    version: VERSION,
  })

  // Watch support (dsh/sessions/watch): the pure translator is injected once
  // per process, and the plugin-fiber listener covers sessions created
  // outside this plugin (web GUI sessions in web-mounted mode); this
  // plugin's own sessions stream through the per-agent event bridge.
  setWatchTranslator((event) => translateSessionEventAll(event as SessionEvent))
  ctx.on('session/event', dispatchGlobalSessionEvent)

  // ── jobs signal (all mount paths) ─────────────────────────────────────────
  // Push `dsh/changed {jobs}` to opted-in clients whenever the job registry
  // moves (start/finish/kill). Hoisted above the per-mode returns so serve,
  // web-mounted and stdio paths all get it; a late-arriving jobs service is
  // still picked up through internal/service (late path below).
  let disposeJobsSignal: (() => void) | undefined
  function attachJobsSignal(jobs: JobsSignal): void {
    if (disposeJobsSignal !== undefined) return
    disposeJobsSignal = jobs.onJobsChanged(() => notifyDshChanged(['jobs']))
  }
  ctx.effect(() => () => {
    disposeJobsSignal?.()
  })
  const jobsNow = ctx.get('jobs') as JobsSignal | undefined
  if (jobsNow !== undefined) attachJobsSignal(jobsNow)

  // ── serve mode ────────────────────────────────────────────────────────────
  // `dsh --profile acp serve` publishes acpServeStartup from the serve-startup
  // row (mounted before this row in cordis.patch.yml); the process becomes a
  // long-lived HTTP+SSE endpoint instead of a stdio child. A serve process is
  // closed by its operator (SIGINT/SIGTERM), never by stdin.
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
    return
  }

  // ── web-mounted mode ──────────────────────────────────────────────────────
  // Inside a web composition the ACP routes ride the shared `webServer`
  // service: the GUI and /acp share one process and one port
  // (`dsh plugin --profile web add dsh-acp-server`, then plain `dsh web`).
  let webMounted = false
  const mountWeb = (webServer: WebServerLike) => {
    if (webMounted) return
    webMounted = true
    const router = createAcpRouter(app, { token: config.token, serveUi: false }, log)
    const dispose = ['/acp', '/acp/stream', '/acp/healthz'].map((path) =>
      webServer.register({ kind: 'exact', path, handler: (req, res) => router.handle(req, res) }),
    )
    log('web-mounted: ACP serving on the shared webServer at /acp')
    ctx.effect(() => () => {
      for (const stop of dispose) stop()
      router.close()
    })
  }

  const present = ctx.get('webServer') as WebServerLike | undefined
  if (present !== undefined) {
    // Deterministic path: a row-level `inject: [agents, agentDefaultModel,
    // webServer]` guarantees the service exists before this fiber mounts.
    mountWeb(present)
    return
  }

  // Late path: installed into a web profile WITHOUT the inject row, this
  // fiber mounts before the web composition provides its server. Subscribe
  // to service provisioning and mount as soon as it arrives; stdio (taken
  // below only when stdout is not a terminal) is handed back untouched -
  // daemon boots exchange no ACP frames before the switch.
  // Push `dsh/changed {jobs}` late-attach: kept for hand-installed
  // compositions where the jobs service provisions after this fiber.
  ctx.on('internal/service', (name: string, value: unknown) => {
    if (name === 'webServer' && value !== undefined) mountWeb(value as WebServerLike)
    if (name === 'jobs' && value !== undefined) attachJobsSignal(value as JobsSignal)
  })

  const stdin = internals.stdin as unknown as Readable
  const stdout = internals.stdout as unknown as Writable & { isTTY?: boolean }

  if (stdout.isTTY === true) {
    // A terminal boot is never an editor child (editors pipe stdio), and an
    // interactive ACP session over a TTY is unusable anyway. Wait for the
    // web composition instead of mangling the terminal with JSON-RPC.
    log('stdout is a terminal; skipping the stdio transport (web-mounted ACP activates with the web composition)')
    return
  }

  // ── stdio mode ────────────────────────────────────────────────────────────
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

  const finish = () => {
    if (closed) return
    // A bare web-profile install (no inject row) may still be providing its
    // server: stdin EOFs immediately on daemon boots, but that must not take
    // the GUI down. Give the web composition a grace period before deciding
    // this was an editor child reaching EOF.
    if (ctx.get('webServer') !== undefined || webMounted) return
    const timer = setTimeout(() => {
      if (closed || webMounted || ctx.get('webServer') !== undefined) return
      log('stdin ended and no web composition appeared; exiting')
      shutdown(0)
    }, WEB_GRACE_MS)
    timer.unref?.()
  }

  stdin.on('end', finish)
  stdin.on('close', finish)
  stdin.on('error', (error) => {
    log(`stdin error: ${String(error)}`)
    shutdown(1)
  })
  process.on('SIGPIPE', () => {
    // The client went away; stdout writes failing are expected then.
  })
}

export default { name, inject, Config, apply, internals }
