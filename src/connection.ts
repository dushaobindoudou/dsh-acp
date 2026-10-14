/**
 * The ACP application: SDK method handlers wired to DSH services.
 * Pure wiring - translations live in translate.ts / wire.ts, streams in
 * event-bridge.ts, session lifecycle in session-entries.ts, and the
 * host-control plane in host-control.ts.
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
  ContentBlock,
} from '@agentclientprotocol/sdk'
import type { ReadableStream, WritableStream } from 'node:stream/web'
import { randomUUID } from 'node:crypto'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AcpSessionTable, AcpSessionEntry } from './table.js'
import { isPermissionPolicy } from './table.js'
import { makeEmitter } from './event-bridge.js'
import {
  attachDshExtensions,
  DSH_EXTENSIONS_KEY,
  notifyDshChanged,
  onVendorRequest,
  registerExtensionClient,
  type DshServiceSnapshot,
} from './dsh-extensions.js'
import { stopReasonOf, acpUsageOf } from './translate.js'
import {
  MODEL_CONFIG_ID,
  REASONING_CONFIG_ID,
  DEFAULT_EFFORT_VALUE,
  modelValueOf,
  parseModelValue,
  validateEffortChoice,
  validateModelChoice,
  type ReasoningInfo,
} from './config-options.js'
import { deletePersistedSession } from './session-delete.js'
import {
  advertise,
  configOptionsOf,
  createOrResumeEntry,
  emitModeChange,
  ensureModelSelection,
  isRunning,
  lastTurnEndOf,
  modeStateOf,
  newEntry,
  openEntry,
  planIdOf,
  providerCatalogOf,
  releaseConnection,
  releaseEntry,
  requireEntry,
  resolvePromptContent,
  singleTextOf,
  type EntryDeps,
} from './session-entries.js'
import { attachHostControl, type GatewayLike, type TypertLike } from './host-control.js'
import { onConnectionClosed, recordCapabilities, trackConnection } from './connections.js'
import { rm as fsRm, readdir as fsReaddir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'

export interface AcpDeps extends EntryDeps {
  readonly ctx: CordisContext
  readonly agents: AgentRegistry
  /** Resolved per session: config pin or the profile's default selection. */
  readonly modelSelection: () => { provider: string; model: string }
  /**
   * Resolve whether image prompts are honestly supported right now: the
   * attachments service accepts at least one ACP image media type AND the
   * current default model route declares `image` input. Mirrors the official
   * dsh-acp `supportsAcpImagePrompts`; over-advertising makes the client offer
   * image uploads that then fail at the model-call stage.
   */
  readonly imageCapability: () => Promise<boolean>
  readonly offerAlwaysPermissions: boolean
  readonly flushOnTurnEnd: boolean
  readonly table: AcpSessionTable
  readonly log: (message: string) => void
  readonly agentName: string
  readonly version: string
  /** Lazy dsh services for the dsh/* vendor extensions (optional per composition). */
  readonly dshServices: () => DshServiceSnapshot
  /**
   * The host-control plane (`dsh/remote/*`): the Typert gateway and registry,
   * or `undefined` when `hostControl: false` keeps the plane off.
   */
  readonly hostControl?: {
    readonly gateway: () => GatewayLike | undefined
    readonly typert: () => TypertLike | undefined
    readonly serviceAvailable: (name: string) => boolean
    readonly deny: readonly string[]
  }
}

/** Vendor methods advertised under `agentCapabilities._meta['dsh/extensions']`. */
const SESSION_CONTROL_METHODS = [
  'dsh/sessions/prompt',
  'dsh/sessions/wait',
  'dsh/sessions/cancel',
  'dsh/sessions/configure',
] as const
const HOST_CONTROL_METHODS = ['dsh/remote/catalog', 'dsh/remote/invoke', 'dsh/remote/stream', 'dsh/remote/cancel'] as const

/** Build the AgentApp with every handler registered. */
export function buildAcpApp(deps: AcpDeps): AgentApp {
  const log = deps.log

  // A closed connection stops receiving updates; its idle sessions are
  // released, running ones when their turn settles (session-entries.ts).
  onConnectionClosed((key) => releaseConnection(deps, key))

  const built = agent({ name: 'dsh-acp' })
  built
    .onRequest('initialize', async ({ params, client }) => {
      // The schema-sanctioned extension point: _meta is an official
      // record<string, unknown> on ClientCapabilities. Standard clients
      // never set it and are never sent dsh/changed notifications.
      const optedIn = registerExtensionClient(client, params as {
        clientCapabilities?: { _meta?: Record<string, unknown> }
      })
      recordCapabilities(client, params.clientCapabilities as Parameters<typeof recordCapabilities>[1])
      if (optedIn) log('dsh/* extensions enabled for this connection')
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: deps.agentName, version: deps.version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: await deps.imageCapability(),
            audio: false,
            embeddedContext: false,
          },
          sessionCapabilities: { close: {}, list: {}, resume: {}, delete: {} },
          // Discovery for orchestrators: which vendor planes this server
          // carries. Inert for standard clients (`_meta` is schema-sanctioned).
          _meta: {
            [DSH_EXTENSIONS_KEY]: {
              sessionDiscovery: ['dsh/sessions/list', 'dsh/sessions/search', 'dsh/sessions/read', 'dsh/sessions/resume', 'dsh/sessions/watch', 'dsh/sessions/unwatch'],
              sessionControl: [...SESSION_CONTROL_METHODS],
              hostControl: deps.hostControl !== undefined ? [...HOST_CONTROL_METHODS] : [],
            },
          },
        },
        authMethods: [],
      }
    })
    // Strict clients authenticate once after the handshake even when
    // authMethods is empty; dsh credentials live outside the ACP surface, so
    // this mirrors the official dsh-acp behavior: an immediate no-op success.
    .onRequest('authenticate', async () => ({}))
    .onRequest('session/new', async ({ params, client }) => {
      if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
        throw new RequestError(-32602, 'session/new requires an absolute cwd')
      }
      const entry = newEntry(`acp-${randomUUID()}`, params.cwd, client)
      // Orchestrators may fix the answering policy at creation, before the
      // first prompt can ask anything (`_meta['dsh/permissionPolicy']`).
      const meta = (params._meta ?? {}) as Record<string, unknown>
      const policy = meta['dsh/permissionPolicy']
      if (isPermissionPolicy(policy)) entry.permissionPolicy = policy
      // Web compositions compose agents from presets (agentPresets/list);
      // `_meta['dsh/agentPreset']` picks one, the registry default otherwise.
      const agentPreset = typeof meta['dsh/agentPreset'] === 'string' ? meta['dsh/agentPreset'] : undefined
      const { sessionId: returned } = await createOrResumeEntry(deps, entry, {
        kind: 'create',
        cwd: params.cwd,
        ...agentPreset !== undefined ? { agentPreset } : {},
      })
      advertise(deps, entry)
      entry.modeId = planIdOf(deps, entry)
      return {
        sessionId: returned,
        modes: modeStateOf(planIdOf(deps, entry)),
        configOptions: await configOptionsOf(deps, entry),
      }
    })
    .onRequest('session/prompt', async ({ params, signal }) => {
      const entry = requireEntry(deps, params.sessionId)
      if (entry.prompting) throw new RequestError(-32602, 'a prompt is already in flight for this session')
      entry.prompting = true
      const onAbort = () => entry.agent.cancel({ kind: 'user' })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        entry.lastTurnEnd = undefined
        entry.turnUsage = undefined // per-turn totals; the bridge folds each reported call in
        // Slash commands: a single text block starting with '/' routes to the
        // dsh command registry first (the same registry the web UI uses).
        const only = singleTextOf(params.prompt)
        if (only !== undefined && only.startsWith('/') && deps.dshServices().commands !== undefined) {
          const execution = await deps.dshServices().commands!.execute(entry.agent, only, [], signal)
          if (execution !== undefined) {
            const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
            const text = execution.result.text ?? ''
            if (text.length > 0) {
              emit({
                sessionUpdate: 'agent_message_chunk',
                messageId: `cmd-${execution.commandId}`,
                content: { type: 'text', text: `${text}\n` },
              })
            }
            // A command may enqueue agent work (/plan, /goal): drain it.
            await entry.agent.whenIdle().catch(() => undefined)
            advertise(deps, entry)
            return { stopReason: 'end_turn', usage: acpUsageOf(entry.turnUsage) }
          }
          // Not a known command: fall through and send it as a prompt.
        }
        entry.agent.followup(createUserMessage({
          content: await resolvePromptContent(deps, params.prompt),
          source: { kind: 'user' },
        }))
        await entry.agent.whenIdle()
        // Re-read through a widening cast: the `= undefined` reset above
        // narrows the property across the await in control-flow analysis.
        const turnEnd = (entry as { lastTurnEnd: TurnEndReason | undefined }).lastTurnEnd
        if (turnEnd?.kind === 'error') {
          // Infrastructure failures (transport, auth, quota) can end a turn
          // without a single message chunk; resolving normally would look
          // like an empty end_turn to the client. Fail the request so the
          // client surfaces the cause.
          const failure = turnEnd.error
          deps.log(`turn failed: ${failure?.message ?? 'unknown error'}`)
          throw new RequestError(-32603, `agent turn failed: ${failure?.message ?? 'unknown error'}`, failure)
        }
        await flushSession(deps, entry)
        return { stopReason: stopReasonOf(entry.lastTurnEnd), usage: acpUsageOf(entry.turnUsage) }
      } finally {
        signal.removeEventListener('abort', onAbort)
        entry.prompting = false
        // Mode may have flipped mid-turn (e.g. the /plan command).
        emitModeChange(deps, entry)
        advertise(deps, entry)
        // Host-plane dirty signal for opted-in clients: a finished turn can
        // change the session list (title fold), goals, and the live tree.
        notifyDshChanged(['sessions', 'goals', 'agents'])
      }
    })
    .onNotification('session/cancel', async ({ params }) => {
      const entry = deps.table.get(params.sessionId)
      if (entry === undefined) return
      entry.agent.cancel({ kind: 'user' })
    })
    .onRequest('session/close', async ({ params }) => {
      const entry = requireEntry(deps, params.sessionId)
      // An adopted session's turn belongs to its owner: closing detaches
      // this server only. Owned sessions are cancelled and disposed.
      await releaseEntry(deps, entry, { cancel: !entry.adopted })
      return {}
    })
    .onRequest('session/list', async ({ params }) => {
      const query = deps.dshServices().sessionQuery
      if (query === undefined) throw new RequestError(-32601, 'session/list unavailable: this composition provides no sessionQuery service')
      const records = await query.listSessions()
      const titles = new Map<string, string>()
      try {
        for (const observation of await query.readTitleSnapshots(records.map((record) => record.header.id))) {
          if ('value' in observation && observation.value.title !== undefined) {
            titles.set(observation.sessionId, observation.value.title.title)
          }
        }
      } catch { /* titles are best-effort */ }
      const cwdFilter = typeof params.cwd === 'string' ? params.cwd : undefined
      return {
        sessions: records
          .filter((record) => cwdFilter === undefined || record.header.cwd === cwdFilter)
          // Newest first: an orchestrator picks up its latest work.
          .sort((a, b) => b.header.createdAt - a.header.createdAt)
          .map((record) => ({
            sessionId: record.header.id,
            cwd: record.header.cwd ?? '/',
            title: titles.get(record.header.id),
            _meta: { live: record.live, parentSession: record.header.parentSession, createdAt: record.header.createdAt },
          })),
        nextCursor: undefined,
      }
    })
    .onRequest('session/resume', async ({ params, client }) => {
      // Reuse (take over from another connection), adopt (live elsewhere),
      // or resume (persisted only) — "switch to this session" in one call.
      const { entry, outcome } = await openEntry(deps, params.sessionId, client, { cwd: params.cwd, rebind: 'always' })
      log(`session/resume ${params.sessionId}: ${outcome}`)
      advertise(deps, entry)
      entry.modeId = planIdOf(deps, entry)
      return { modes: modeStateOf(planIdOf(deps, entry)), configOptions: await configOptionsOf(deps, entry) }
    })
    .onRequest('session/load', async ({ params, client }) => {
      const { entry, outcome } = await openEntry(deps, params.sessionId, client, { cwd: params.cwd, rebind: 'always' })
      log(`session/load ${params.sessionId}: ${outcome}`)
      // Replay the surface transcript as chunks so the client can render
      // history it did not store itself.
      const query = deps.dshServices().sessionQuery
      if (query !== undefined) {
        const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
        try {
          const surface = await query.readSurface(params.sessionId)
          for (const [index, event] of [...surface.events].entries()) {
            let text = ''
            try {
              text = extractSessionEventText(event as never).trim()
            } catch { text = '' }
            if (text.length === 0) continue
            const seq = typeof (event as { seq?: number }).seq === 'number' ? (event as { seq: number }).seq : index
            emit({
              sessionUpdate: String(event.type).startsWith('user') ? 'user_message_chunk' : 'agent_message_chunk',
              messageId: `load-${seq}`,
              content: { type: 'text', text: `${text}\n` },
            })
          }
        } catch (error) {
          deps.log(`session/load replay failed: ${String(error instanceof Error ? error.message : error)}`)
        }
      }
      advertise(deps, entry)
      entry.modeId = planIdOf(deps, entry)
      return { modes: modeStateOf(planIdOf(deps, entry)), configOptions: await configOptionsOf(deps, entry) }
    })
    .onRequest('session/set_mode', async ({ params }) => {
      const entry = requireEntry(deps, params.sessionId)
      const planMode = deps.dshServices().planMode
      if (planMode === undefined) throw new RequestError(-32601, 'session/set_mode unavailable: this composition provides no planMode service')
      if (params.modeId !== 'default' && params.modeId !== 'plan') {
        throw new RequestError(-32602, `unknown mode: ${params.modeId}`)
      }
      const outcome = planMode.set(entry.agent, params.modeId === 'plan')
      deps.log(`set_mode ${params.modeId}: ${outcome}`)
      entry.modeId = params.modeId
      const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
      emit({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
      return {}
    })
    .onRequest('session/set_config_option', async ({ params }) => {
      const entry = requireEntry(deps, params.sessionId)
      const llm = deps.dshServices().llm
      if (llm === undefined) throw new RequestError(-32601, 'session/set_config_option unavailable: this composition provides no llm service')
      // Only selects are exposed; a boolean payload is a client bug, not a
      // silent no-op.
      if (typeof params.value === 'boolean') {
        throw new RequestError(-32602, `config option ${params.configId} is a select; boolean values are not accepted`)
      }
      if (typeof params.value !== 'string' || params.value.length === 0) {
        throw new RequestError(-32602, `config option ${params.configId} requires a non-empty string value`)
      }
      const current = entry.modelRef.current
      if (current === undefined) throw new RequestError(-32603, 'session has no model selection to override')
      let next: { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> }
      if (params.configId === MODEL_CONFIG_ID) {
        const parsed = parseModelValue(params.value)
        if (parsed === undefined) {
          throw new RequestError(-32602, `invalid model value: ${params.value} (expected <provider>/<model>)`)
        }
        const error = validateModelChoice(await providerCatalogOf(llm), parsed)
        if (error !== undefined) throw new RequestError(-32602, error)
        // An absent effort intentionally clears any inherited effort: the new
        // route starts from its provider default (dsh model-selection
        // contract), and takes effect on the NEXT step.
        next = { provider: parsed.provider, model: parsed.model }
      } else if (params.configId === REASONING_CONFIG_ID) {
        let reasoning: ReasoningInfo | undefined
        try {
          reasoning = (await llm.resolveModelInfo(current.provider, current.model)).reasoning
        } catch (error) {
          throw new RequestError(-32602, `cannot resolve the current model route ${modelValueOf(current)}: ${String(error instanceof Error ? error.message : error)}`)
        }
        if (reasoning === undefined || reasoning.efforts.length === 0) {
          // Refuse loudly instead of silently ignoring: the client believes
          // the effort changed when it did not.
          throw new RequestError(-32602, `the current model route ${modelValueOf(current)} does not support reasoning efforts`)
        }
        const error = validateEffortChoice(reasoning, params.value)
        if (error !== undefined) throw new RequestError(-32602, error)
        next = {
          provider: current.provider,
          model: current.model,
          ...params.value === DEFAULT_EFFORT_VALUE ? {} : { reasoningEffort: ReasoningEffortId(params.value) },
        }
      } else {
        throw new RequestError(-32602, `unknown config option: ${params.configId} (available: ${MODEL_CONFIG_ID}, ${REASONING_CONFIG_ID})`)
      }
      await applyModelSelection(deps, entry, next)
      deps.log(`set_config_option ${params.configId} -> ${params.value} (session ${entry.sessionId})`)
      const configOptions = await configOptionsOf(deps, entry)
      const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
      emit({ sessionUpdate: 'config_option_update', configOptions })
      return { configOptions }
    })
    .onRequest('session/delete', async ({ params }) => {
      const sessionId = params.sessionId
      if (deps.table.get(sessionId) !== undefined) {
        throw new RequestError(-32602, `session ${sessionId} is open here; close it with session/close before deleting`)
      }
      const sessions = deps.ctx.get('sessions') as { get(id: string): unknown } | undefined
      if (sessions !== undefined && sessions.get(SessionId(sessionId)) !== undefined) {
        throw new RequestError(-32602, `session ${sessionId} is live in this process; close it before deleting`)
      }
      const persistence = deps.dshServices().sessionPersistence
      if (persistence === undefined) throw new RequestError(-32601, 'session/delete unavailable: this composition provides no sessionPersistence service')
      await deletePersistedSession({
        persistence,
        sessionId,
        fs: { readdir: fsReaddir, rm: fsRm },
        fallbackRoot: pathJoin(process.env.DSH_HOME ?? pathJoin(process.env.HOME ?? '.', '.dsh'), 'sessions'),
      })
      deps.log(`deleted persisted session ${sessionId}`)
      notifyDshChanged(['sessions'])
      return {}
    })

  onVendorRequest(built, 'dsh/sessions/resume', async ({ params, client }) => {
    const target = (params as { sessionId?: unknown }).sessionId
    if (typeof target !== 'string' || target.length === 0) {
      throw new RequestError(-32602, 'dsh/sessions/resume requires a sessionId')
    }
    const { entry, outcome } = await openEntry(deps, target, client, { rebind: 'always' })
    return { sessionId: entry.sessionId, cwd: entry.cwd, outcome }
  })

  attachSessionControl(built, deps)
  if (deps.hostControl !== undefined) {
    attachHostControl(built, { ...deps.hostControl, log })
  }

  attachDshExtensions(built, {
    services: deps.dshServices,
    openDshSessionIds: () =>
      new Set(deps.table.list().map((entry) => entry.agent.session.id as string)),
    entryOf: (sessionId) => deps.table.get(sessionId),
    log,
  })
  return built
}

/**
 * Orchestration verbs over ANY session of the process — ACP-opened, adopted
 * GUI sessions, or persisted ones (opened on demand) — that never hold the
 * caller's request open for a whole turn:
 *
 *   dsh/sessions/prompt     enqueue (or steer) a prompt; returns at once
 *   dsh/sessions/wait       wait for idle, bounded by timeoutMs (0 = poll)
 *   dsh/sessions/cancel     cancel the running turn of any live session
 *   dsh/sessions/configure  set the session's permission/question policy
 *
 * Together with `session/new` they make fire-and-forget dispatch possible:
 * prompt N sessions, disconnect, come back and wait/read.
 */
function attachSessionControl(app: AgentApp, deps: AcpDeps): void {
  const idOf = (method: string, params: unknown): string => {
    const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new RequestError(-32602, `${method} requires a sessionId`)
    return sessionId
  }
  const policyOf = (method: string, params: unknown) => {
    const policy = (params as { permissionPolicy?: unknown } | undefined)?.permissionPolicy
    if (policy === undefined) return undefined
    if (!isPermissionPolicy(policy)) throw new RequestError(-32602, `${method}: permissionPolicy must be ask | auto | deny`)
    return policy
  }

  onVendorRequest(app, 'dsh/sessions/prompt', async ({ params, client }) => {
    const sessionId = idOf('dsh/sessions/prompt', params)
    const record = params as { prompt?: unknown; mode?: unknown }
    const blocks: ContentBlock[] | undefined = typeof record.prompt === 'string'
      ? [{ type: 'text', text: record.prompt }]
      : Array.isArray(record.prompt) ? record.prompt as ContentBlock[] : undefined
    if (blocks === undefined || blocks.length === 0) {
      throw new RequestError(-32602, 'dsh/sessions/prompt requires a prompt (a string or ACP content blocks)')
    }
    const mode = record.mode ?? 'queue'
    if (mode !== 'queue' && mode !== 'steer') throw new RequestError(-32602, 'dsh/sessions/prompt: mode must be queue | steer')
    const policy = policyOf('dsh/sessions/prompt', params)
    // Never steal a session another live connection is driving: dispatch
    // binds only an unbound session to the caller.
    const { entry, outcome } = await openEntry(deps, sessionId, client, { rebind: 'if-unbound' })
    if (policy !== undefined) entry.permissionPolicy = policy
    const message = createUserMessage({ content: await resolvePromptContent(deps, blocks as never), source: { kind: 'user' } })
    if (mode === 'steer') entry.agent.steer(message)
    else entry.agent.followup(message)
    entry.lastTurnEnd = undefined
    deps.log(`dsh/sessions/prompt ${mode} -> ${sessionId} (${outcome})`)
    // Persist the turn when it settles, like a blocking session/prompt does.
    void entry.agent.whenIdle().then(() => flushSession(deps, entry), () => undefined)
    notifyDshChanged(['agents'])
    return { sessionId, accepted: true, outcome, status: entry.agent.status }
  })

  onVendorRequest(app, 'dsh/sessions/wait', async ({ params, signal }) => {
    const sessionId = idOf('dsh/sessions/wait', params)
    const raw = (params as { timeoutMs?: unknown }).timeoutMs
    const timeoutMs = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 2_147_483_647) : 30_000
    const entry = deps.table.get(sessionId)
    const live = entry?.agent ?? deps.agents.get(SessionId(sessionId))
    if (live === undefined) {
      const stat = await deps.dshServices().sessionPersistence?.stat(sessionId).catch(() => undefined)
      if (stat === undefined) throw new RequestError(-32602, `unknown session: ${sessionId}`)
      return { sessionId, live: false, idle: true }
    }
    const busy = () => (entry !== undefined ? isRunning(entry) : live.status === 'running')
    if (busy() && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
        const done = () => { clearTimeout(timer); resolve() }
        signal?.addEventListener('abort', done, { once: true })
        live.whenIdle().then(done, done)
      })
    }
    const idle = !busy()
    const turnEnd = entry?.lastTurnEnd ?? lastTurnEndOf(live)
    return {
      sessionId,
      live: true,
      idle,
      status: live.status,
      ...idle && turnEnd !== undefined
        ? {
            stopReason: stopReasonOf(turnEnd),
            turnEnd: turnEnd.kind,
            ...turnEnd.kind === 'error' ? { error: turnEnd.error?.message ?? 'unknown error' } : {},
          }
        : {},
    }
  })

  onVendorRequest(app, 'dsh/sessions/cancel', async ({ params }) => {
    const sessionId = idOf('dsh/sessions/cancel', params)
    const live = deps.table.get(sessionId)?.agent ?? deps.agents.get(SessionId(sessionId))
    if (live === undefined) return { sessionId, cancelled: false, live: false }
    const wasRunning = live.status === 'running'
    live.cancel({ kind: 'user' })
    return { sessionId, cancelled: wasRunning, live: true }
  })

  onVendorRequest(app, 'dsh/sessions/configure', async ({ params, client }) => {
    const sessionId = idOf('dsh/sessions/configure', params)
    const policy = policyOf('dsh/sessions/configure', params)
    const { entry, outcome } = await openEntry(deps, sessionId, client, { rebind: 'if-unbound' })
    if (policy !== undefined) entry.permissionPolicy = policy
    return { sessionId, outcome, permissionPolicy: entry.permissionPolicy, adopted: entry.adopted }
  })
}

/**
 * Point the session at a new model route. Owned sessions rewrite their own
 * installed selection (effective next step). Adopted sessions prefer the
 * host's own selector (`session/selectModel`, the GUI's path, so the owner's
 * selection and this one never diverge) and install one only when the
 * composition has no such selector.
 */
async function applyModelSelection(
  deps: AcpDeps,
  entry: AcpSessionEntry,
  next: { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> },
): Promise<void> {
  if (entry.adopted) {
    const gateway = deps.hostControl?.gateway()
    const selector = deps.hostControl?.typert()?.local.get('session/selectModel')
    if (gateway !== undefined && selector !== undefined) {
      await gateway.invoke({
        namespace: 'session',
        method: 'selectModel',
        args: { request: { sessionId: entry.sessionId, provider: next.provider, model: next.model, ...next.reasoningEffort !== undefined ? { reasoningEffort: next.reasoningEffort } : {} } },
      })
      entry.modelRef.current = next
      entry.contextWindow = undefined
      return
    }
    ensureModelSelection(entry)
  }
  entry.modelRef.current = next
  entry.contextWindow = undefined
}

/** Flush the session's persistence after a turn (best-effort, config-gated). */
async function flushSession(deps: AcpDeps, entry: AcpSessionEntry): Promise<void> {
  const sessions = deps.ctx.get('sessions')
  if (!deps.flushOnTurnEnd || sessions === undefined) return
  try {
    await sessions.flush(entry.agent.session)
  } catch {
    // Persistence checkpoints drain independently; a flush failure must not
    // fail the completed turn.
  }
}

/** Connect the app over NDJSON stdio (web streams). */
export function connectStdio(
  app: AgentApp,
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
): AgentConnection {
  const connection = app.connect(ndJsonStream(stdout, stdin))
  trackConnection(connection)
  return connection
}
