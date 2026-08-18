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
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AcpSessionTable, AcpSessionEntry } from './table.js'
import { attachEventBridge, makeEmitter, translateSessionEvent } from './event-bridge.js'
import { attachPermBridge } from './perm-bridge.js'
import { setWatchTranslator } from './watch.js'
import {
  attachDshExtensions,
  notifyDshChanged,
  onVendorRequest,
  registerExtensionClient,
  type DshServiceSnapshot,
} from './dsh-extensions.js'
import { promptToContent, stopReasonOf, promptImages, IMAGE_MEDIA_TYPES } from './translate.js'

export interface AcpDeps {
  readonly ctx: CordisContext
  readonly agents: AgentRegistry
  /** Resolved once at boot: config pin or the profile's default selection. */
  readonly modelSelection: () => { provider: string; model: string }
  readonly offerAlwaysPermissions: boolean
  readonly flushOnTurnEnd: boolean
  readonly table: AcpSessionTable
  readonly log: (message: string) => void
  readonly agentName: string
  readonly version: string
  /** Lazy dsh services for the dsh/* vendor extensions (optional per composition). */
  readonly dshServices: () => DshServiceSnapshot
  /** Lazy attachments service; its presence flips the image prompt capability. */
  readonly attachments: () => {
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{ attachmentId: unknown; mediaType: string; bytes: number; width: number }>
  } | undefined
}

/** ACP modes: the dsh plan-mode seam mapped onto standard session modes. */
const MODES: Array<{ id: string; name: string; description: string }> = [
  { id: 'default', name: 'Default', description: 'Full agent capabilities' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning mode (dsh plan mode)' },
]

interface PlanModeLike {
  get(agent: { id: string }): { active: boolean } | undefined
  set(agent: unknown, active: boolean): string
}

interface CommandsLike {
  list(agent: unknown): ReadonlyArray<{ name: string; description: string }>
  execute(agent: unknown, line: string, signal: AbortSignal): Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>
}

function modeStateOf(current: 'default' | 'plan') {
  return { currentModeId: current, availableModes: MODES.map((mode) => ({ ...mode })) }
}

/** Build the AgentApp with every handler registered. */
export function buildAcpApp(deps: AcpDeps): AgentApp {
  const log = deps.log

  const built = agent({ name: 'dsh-acp' })
  built
    .onRequest('initialize', async ({ params, client }) => {
      // The schema-sanctioned extension point: _meta is an official
      // record<string, unknown> on ClientCapabilities. Standard clients
      // never set it and are never sent dsh/changed notifications.
      const optedIn = registerExtensionClient(client, params as {
        clientCapabilities?: { _meta?: Record<string, unknown> }
      })
      if (optedIn) log('dsh/* extensions enabled for this connection')
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: deps.agentName, version: deps.version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: deps.attachments() !== undefined,
            audio: false,
            embeddedContext: false,
          },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      }
    })
    .onRequest('session/new', async ({ params, client }) => {
      if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
        throw new RequestError(-32602, 'session/new requires an absolute cwd')
      }
      const sessionId = `acp-${randomUUID()}`
      // Evaluated per session: the live default follows config-store
      // loads and in-GUI model switches instead of a mount-time snapshot.
      const selection = deps.modelSelection()
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
        // Bound to the connection that created it: every notification for
        // this session (updates, permission requests) goes to THAT client.
        // A single shared context would let the latest connection steal
        // another client's sessions.
        client,
      }
      const { sessionId: returned } = await createOrResumeEntry(deps, entry, {
        kind: 'create',
        cwd: params.cwd,
      })
      advertise(deps, entry)
      entry.modeId = planIdOf(deps, entry)
      return { sessionId: returned, modes: modeStateOf(planIdOf(deps, entry)) }
    })
    .onRequest('session/prompt', async ({ params, signal }) => {
      const entry = requireEntry(deps, params.sessionId)
      if (entry.prompting) throw new RequestError(-32602, 'a prompt is already in flight for this session')
      entry.prompting = true
      const onAbort = () => entry.agent.cancel({ kind: 'user' })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        entry.lastTurnEnd = undefined
        // Slash commands: a single text block starting with '/' routes to the
        // dsh command registry first (the same registry the web UI uses).
        const only = singleTextOf(params.prompt)
        if (only !== undefined && only.startsWith('/') && deps.dshServices().commands !== undefined) {
          const execution = await deps.dshServices().commands!.execute(entry.agent, only, signal)
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
            return { stopReason: 'end_turn' }
          }
          // Not a known command: fall through and send it as a prompt.
        }
        entry.agent.followup(createUserMessage({
          content: await resolvePromptContent(deps, params.prompt),
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
      entry.agent.cancel({ kind: 'user' })
      await entry.agent.whenIdle().catch(() => undefined)
      deps.table.remove(params.sessionId)
      await entry.dispose()
      notifyDshChanged(['sessions', 'agents'])
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
          .map((record) => ({
            sessionId: record.header.id,
            cwd: record.header.cwd ?? '/',
            title: titles.get(record.header.id),
          }))
          .sort((a, b) => (titles.get(a.sessionId) ?? '').localeCompare(titles.get(b.sessionId) ?? '')),
        nextCursor: undefined,
      }
    })
    .onRequest('session/resume', async ({ params, client }) => {
      if (deps.table.get(params.sessionId) !== undefined) {
        throw new RequestError(-32602, `session ${params.sessionId} is already open here; use it directly`)
      }
      const entry: AcpSessionEntry = {
        sessionId: params.sessionId,
        agent: undefined as unknown as AcpSessionEntry['agent'],
        dispose: async () => undefined,
        cwd: params.cwd,
        lastTurnEnd: undefined,
        prompting: false,
        client,
      }
      await createOrResumeEntry(deps, entry, { kind: 'resume', resumeSessionId: params.sessionId })
      advertise(deps, entry)
      entry.modeId = planIdOf(deps, entry)
      return { modes: modeStateOf(planIdOf(deps, entry)) }
    })
    .onRequest('session/load', async ({ params, client }) => {
      if (deps.table.get(params.sessionId) !== undefined) {
        throw new RequestError(-32602, `session ${params.sessionId} is already open here; use session/resume instead`)
      }
      const entry: AcpSessionEntry = {
        sessionId: params.sessionId,
        agent: undefined as unknown as AcpSessionEntry['agent'],
        dispose: async () => undefined,
        cwd: params.cwd,
        lastTurnEnd: undefined,
        prompting: false,
        client,
      }
      await createOrResumeEntry(deps, entry, { kind: 'resume', resumeSessionId: params.sessionId })
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
      return {}
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
      const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
      emit({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
      return {}
    })

  onVendorRequest(built, 'dsh/sessions/resume', async ({ params, client }) => {
    const target = (params as { sessionId?: unknown }).sessionId
    if (typeof target !== 'string' || target.length === 0) {
      throw new RequestError(-32602, 'dsh/sessions/resume requires a sessionId')
    }
    if (deps.table.get(target) !== undefined) {
      throw new RequestError(-32602, `session ${target} is already open here; use it directly`)
    }
    const entry: AcpSessionEntry = {
      sessionId: target,
      agent: undefined as unknown as AcpSessionEntry['agent'],
      dispose: async () => undefined,
      cwd: '/',
      lastTurnEnd: undefined,
      prompting: false,
      client,
    }
    const { sessionId: returned, cwd } = await createOrResumeEntry(deps, entry, {
      kind: 'resume',
      resumeSessionId: target,
    })
    return { sessionId: returned, cwd }
  })

  attachDshExtensions(built, {
    services: deps.dshServices,
    openDshSessionIds: () =>
      new Set(deps.table.list().map((entry) => entry.agent.session.id as string)),
    log,
  })
  return built
}

/**
 * Shared creation path for session/new (fresh id) and dsh/sessions/resume
 * (persisted id): bridges, model selection, and table registration are
 * identical - only the agents-service call differs.
 */
async function createOrResumeEntry(
  deps: AcpDeps,
  entry: AcpSessionEntry,
  mode: { kind: 'create'; cwd: string } | { kind: 'resume'; resumeSessionId: string },
): Promise<{ sessionId: string; cwd: string }> {
  const log = deps.log
  const selection = deps.modelSelection()
  const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, log)
  const setup = (agentCtx: CordisContext) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    attachEventBridge(agentCtx, entry, emit)
    attachPermBridge(agentCtx, entry.sessionId, entry, deps.offerAlwaysPermissions, () => entry.client, log)
  }
  const handle = mode.kind === 'create'
    ? await deps.agents.create({
        sessionId: SessionId(entry.sessionId),
        meta: { cwd: mode.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      })
    : await deps.agents.resume({
        resumeSessionId: SessionId(mode.resumeSessionId),
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      })
  entry.agent = handle.agent
  entry.dispose = handle.dispose
  entry.cwd = (handle.agent.session.header?.cwd as string | undefined) ?? entry.cwd
  deps.table.add(entry)
  notifyDshChanged(['sessions', 'agents'])
  return { sessionId: entry.agent.id as string, cwd: entry.cwd }
}

/** The prompt's single text block, if it is exactly one text block. */
function singleTextOf(prompt: ReadonlyArray<{ type: string; text?: string }> | undefined): string | undefined {
  if (prompt === undefined || prompt.length !== 1 || prompt[0] === undefined) return undefined
  if (prompt[0].type !== 'text') return undefined
  return prompt[0].text
}

/** Fold ACP prompt blocks into dsh content; images persist through attachments. */
async function resolvePromptContent(deps: AcpDeps, prompt: ReadonlyArray<Record<string, unknown>>): Promise<ReturnType<typeof promptToContent>> {
  const text = promptToContent(prompt as never)
  const attachments = deps.attachments()
  const images = promptImages(prompt as never)
  if (attachments === undefined || images.length === 0) return text
  const blocks: Array<unknown> = text.map((part) => part)
  for (const [index, image] of images.entries()) {
    if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mimeType)) {
      throw new RequestError(-32602, `unsupported image mime type: ${image.mimeType} (allowed: ${IMAGE_MEDIA_TYPES.join(', ')})`)
    }
    try {
      const ref = await attachments.saveImage({
        data: new Uint8Array(Buffer.from(image.data, 'base64')),
        mediaType: image.mimeType,
        name: `acp-prompt-${index}`,
      })
      blocks.push({ type: 'image', attachment: ref })
    } catch (error) {
      throw new RequestError(-32603, `image attachment failed: ${String(error instanceof Error ? error.message : error)}`)
    }
  }
  return blocks as ReturnType<typeof promptToContent>
}

/** Current plan-mode id, defaulting to 'default' without the service. */
function planIdOf(deps: AcpDeps, entry: AcpSessionEntry): 'default' | 'plan' {
  const planMode = deps.dshServices().planMode
  if (planMode === undefined) return 'default'
  return planMode.get(entry.agent)?.active === true ? 'plan' : 'default'
}

/** Notify a mode change when it differs from the entry's last advertised id. */
function emitModeChange(deps: AcpDeps, entry: AcpSessionEntry): void {
  const current = planIdOf(deps, entry)
  if (entry.modeId === current) return
  entry.modeId = current
  const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
  emit({ sessionUpdate: 'current_mode_update', currentModeId: current })
}

/** Advertise slash commands (available_commands_update) for one session. */
function advertise(deps: AcpDeps, entry: AcpSessionEntry): void {
  const commands = deps.dshServices().commands
  if (commands === undefined || entry.client === undefined) return
  try {
    const availableCommands = commands.list(entry.agent).map((command) => ({
      name: command.name,
      description: command.description,
    }))
    const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
    emit({ sessionUpdate: 'available_commands_update', availableCommands })
  } catch (error) {
    deps.log(`commands advertise failed: ${String(error instanceof Error ? error.message : error)}`)
  }
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
