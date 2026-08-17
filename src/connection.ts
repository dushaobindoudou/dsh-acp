/**
 * The ACP application: SDK method handlers wired to DSH services.
 * Pure wiring - translations live in translate.ts, streams in event-bridge.ts.
 */
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import type {
  AgentApp,
  AgentConnection,
  AgentContext,
} from '@agentclientprotocol/sdk'
import type { ReadableStream, WritableStream } from 'node:stream/web'
import { randomUUID } from 'node:crypto'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AcpSessionTable, AcpSessionEntry } from './table.js'
import { attachEventBridge, makeEmitter } from './event-bridge.js'
import { attachPermBridge } from './perm-bridge.js'
import { promptToContent, stopReasonOf } from './translate.js'

export interface AcpDeps {
  readonly ctx: CordisContext
  readonly agents: AgentRegistry
  /** Resolved once at boot: config pin or the profile's default selection. */
  readonly modelSelection: { provider: string; model: string }
  readonly offerAlwaysPermissions: boolean
  readonly flushOnTurnEnd: boolean
  readonly table: AcpSessionTable
  readonly log: (message: string) => void
  readonly agentName: string
  readonly version: string
}

/** Build the AgentApp with every M1 handler registered. */
export function buildAcpApp(deps: AcpDeps): AgentApp {
  let connectionContext: AgentContext | undefined
  const context = () => connectionContext
  const log = deps.log

  return agent({ name: 'dsh-acp' })
    .onRequest('initialize', async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: deps.agentName, version: deps.version },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    }))
    .onRequest('session/new', async ({ params }) => {
      if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
        throw new RequestError(-32602, 'session/new requires an absolute cwd')
      }
      const sessionId = `acp-${randomUUID()}`
      const selection = deps.modelSelection
      // The entry object exists before the agent: setup listeners close over
      // it and only touch the live fields (lastTurnEnd), never the agent
      // reference, which is filled in synchronously after create resolves.
      const entry: AcpSessionEntry = {
        sessionId,
        agent: undefined as unknown as AcpSessionEntry['agent'],
        dispose: async () => undefined,
        cwd: params.cwd,
        lastTurnEnd: undefined,
        prompting: false,
      }
      const emit = makeEmitter(sessionId, { context }, log)
      const { agent: created, dispose } = await deps.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: params.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          attachEventBridge(agentCtx, entry, emit)
          attachPermBridge(agentCtx, sessionId, entry, deps.offerAlwaysPermissions, context, log)
        },
      })
      entry.agent = created
      entry.dispose = dispose
      deps.table.add(entry)
      return { sessionId }
    })
    .onRequest('session/prompt', async ({ params, signal }) => {
      const entry = requireEntry(deps, params.sessionId)
      if (entry.prompting) throw new RequestError(-32602, 'a prompt is already in flight for this session')
      entry.prompting = true
      const onAbort = () => entry.agent.cancel({ kind: 'user' })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        entry.lastTurnEnd = undefined
        entry.agent.followup(createUserMessage({
          content: promptToContent(params.prompt),
          source: { kind: 'user' },
        }))
        await entry.agent.whenIdle()
        // Re-read through a widening cast: the `= undefined` reset above
        // narrows the property across the await in control-flow analysis
        // (and would narrow any local initialized from it straight to
        // `undefined`, making the error check below `never`).
        const turnEnd = (entry as { lastTurnEnd: TurnEndReason | undefined }).lastTurnEnd
        if (turnEnd?.kind === 'error') {
          // Infrastructure failures (transport, auth, quota) can end a turn
          // without a single message chunk; resolving normally would look
          // like an empty end_turn to the client. Fail the request so the
          // client surfaces the cause (ACP reports turn errors through the
          // response, not through stopReason).
          const failure = turnEnd.error
          deps.log(`turn failed: ${failure?.message ?? 'unknown error'}`)
          throw new RequestError(-32603, `agent turn failed: ${failure?.message ?? 'unknown error'}`, failure)
        }
        const sessions = deps.ctx.get('sessions')
        if (deps.flushOnTurnEnd && sessions !== undefined) {
          try {
            await sessions.flush(entry.agent.session)
          } catch {
            // Persistence checkpoints drain independently; a flush failure
            // must not fail the completed turn.
          }
        }
        return { stopReason: stopReasonOf(entry.lastTurnEnd) }
      } finally {
        signal.removeEventListener('abort', onAbort)
        entry.prompting = false
      }
    })
    .onNotification('session/cancel', async ({ params }) => {
      const entry = deps.table.get(params.sessionId)
      if (entry === undefined) return
      entry.agent.cancel({ kind: 'user' })
    })
    .onRequest('session/close', async ({ params }) => {
      const entry = requireEntry(deps, params.sessionId)
      entry.agent.cancel({ kind: 'user' })
      await entry.agent.whenIdle().catch(() => undefined)
      deps.table.remove(params.sessionId)
      await entry.dispose()
      return {}
    })
    .onConnect((conn) => {
      connectionContext = (conn as unknown as AgentConnection).client
    })
}

function requireEntry(deps: AcpDeps, sessionId: string): AcpSessionEntry {
  const entry = deps.table.get(sessionId)
  if (entry === undefined) throw new RequestError(-32602, `unknown session: ${sessionId}`)
  return entry
}

/** Connect the app over NDJSON stdio (web streams). */
export function connectStdio(
  app: AgentApp,
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
): AgentConnection {
  return app.connect(ndJsonStream(stdout, stdin))
}
