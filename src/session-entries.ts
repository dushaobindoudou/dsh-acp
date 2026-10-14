/**
 * ACP session entries: how one dsh session becomes (and stops being) an ACP
 * session of some connection.
 *
 * Three ways in, tried in this order by {@link openEntry}:
 *  - reuse: the session is already in this process's ACP table — rebind it
 *    to the calling connection (a master reconnecting, a second CLI call);
 *  - adopt: the agent is live but owned elsewhere (the web GUI, a subagent
 *    parent, another plugin) — attach the bridges to its scope without
 *    taking ownership;
 *  - resume: the session is only persisted — start it as an owned agent.
 *
 * Ownership decides the way out: an owned entry is cancelled and disposed,
 * an adopted one only detaches its listeners and leaves the agent running.
 */
import { RequestError } from '@agentclientprotocol/sdk'
import type { AgentContext } from '@agentclientprotocol/sdk'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AcpSessionTable, AcpSessionEntry, PermissionPolicy } from './table.js'
import { attachEventBridge, makeEmitter } from './event-bridge.js'
import { attachPermBridge } from './perm-bridge.js'
import { attachQuestionBridge } from './question-bridge.js'
import { notifyDshChanged, type DshServiceSnapshot } from './dsh-extensions.js'
import { connectionKeyOf, type ConnectionKey } from './connections.js'
import { promptToContent, promptImages, IMAGE_MEDIA_TYPES } from './translate.js'
import {
  buildModelOption,
  buildReasoningOption,
  type ProviderCatalog,
} from './config-options.js'

/** The slice of the plugin deps the entry machinery needs. */
export interface EntryDeps {
  readonly ctx: CordisContext
  readonly agents: AgentRegistry
  readonly modelSelection: () => { provider: string; model: string }
  readonly offerAlwaysPermissions: boolean
  readonly table: AcpSessionTable
  readonly log: (message: string) => void
  readonly dshServices: () => DshServiceSnapshot
  readonly attachments: () => {
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{ attachmentId: unknown; mediaType: string; bytes: number; width: number }>
  } | undefined
}

/** A fresh, agent-less entry bound to `client`. */
export function newEntry(sessionId: string, cwd: string, client: AgentContext | undefined): AcpSessionEntry {
  return {
    sessionId,
    // The entry exists before the agent: setup listeners close over it and
    // only touch the live fields, never the agent reference, which is
    // filled in synchronously after create/resume resolves.
    agent: undefined as unknown as AcpSessionEntry['agent'],
    dispose: async () => undefined,
    cwd,
    lastTurnEnd: undefined,
    prompting: false,
    // Bound to the connection that opened it: every notification for this
    // session (updates, permission requests, questions) goes to THAT client.
    client,
    modelRef: undefined as unknown as AcpSessionEntry['modelRef'],
    turnUsage: undefined,
    contextWindow: undefined,
    adopted: false,
    permissionPolicy: 'ask',
    detach: [],
    modelSelectionInstalled: false,
  }
}

/** Context-window resolver for usage updates, cached on the entry. */
function contextWindowResolver(deps: EntryDeps, entry: AcpSessionEntry): () => Promise<number | undefined> {
  return async () => {
    if (entry.contextWindow !== undefined) return entry.contextWindow
    const llm = deps.dshServices().llm
    const current = entry.modelRef.current
    if (llm === undefined || current === undefined) return undefined
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      entry.contextWindow = info.context?.contextWindow
    } catch { /* unknown route: usage updates stay silent */ }
    return entry.contextWindow
  }
}

/** The slice of `ctx.agentPresets` (web compositions) agent composition uses. */
interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(ctx: CordisContext, id?: string): Promise<{ id: string }>
}

/**
 * The agent preset a session is composed from, exactly like the GUI's own
 * sessions: a requested (or the registry's default) preset on create, the
 * session's recorded `agentPreset` projection on resume. `undefined` in a
 * preset-free composition (the bare acp profile), where tools come from the
 * profile tree directly. Without this, ACP sessions in a web composition
 * would miss every preset-scoped tool (ask_user_question, todo, subagents,
 * web, workflow) and the preset persona.
 */
async function presetFor(
  deps: EntryDeps,
  mode: { kind: 'create'; requested?: string } | { kind: 'resume'; sessionId: string },
): Promise<{ presets: AgentPresetsLike; id: string } | undefined> {
  const presets = deps.ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (presets === undefined) return undefined
  let requested: string | undefined
  if (mode.kind === 'create') requested = mode.requested
  else requested = await storedPresetOf(deps, mode.sessionId)
  try {
    return { presets, id: (await presets.resolve(requested)).id }
  } catch (error) {
    if (requested !== undefined && mode.kind === 'create') {
      throw new RequestError(-32602, `unknown agent preset: ${requested} (${String(error instanceof Error ? error.message : error)}; see agentPresets/list)`)
    }
    deps.log(`agent preset unavailable (${String(error instanceof Error ? error.message : error)}); composing without one`)
    return undefined
  }
}

/** The `agentPreset` projection recorded in a persisted session, if any. */
async function storedPresetOf(deps: EntryDeps, sessionId: string): Promise<string | undefined> {
  const query = deps.ctx.get('sessionQuery') as {
    observeSession?(id: unknown): Promise<{ projections?: { values?: Record<string, unknown> }; [Symbol.dispose]?(): void }>
  } | undefined
  if (query?.observeSession === undefined) return undefined
  let observation: Awaited<ReturnType<NonNullable<typeof query.observeSession>>> | undefined
  try {
    observation = await query.observeSession(SessionId(sessionId))
    const value = observation.projections?.values?.agentPreset
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  } finally {
    try { observation?.[Symbol.dispose]?.() } catch { /* best-effort release */ }
  }
}

/**
 * Shared creation path for a fresh session and a persisted resume: bridges,
 * model selection, preset composition, and table registration are identical
 * — only the agents-service call differs.
 */
export async function createOrResumeEntry(
  deps: EntryDeps,
  entry: AcpSessionEntry,
  mode: { kind: 'create'; cwd: string; agentPreset?: string } | { kind: 'resume'; resumeSessionId: string },
): Promise<{ sessionId: string; cwd: string }> {
  const log = deps.log
  // Evaluated per session: the live default follows config-store loads and
  // in-GUI model switches instead of a mount-time snapshot.
  const selection = deps.modelSelection()
  // The ref is OWNED here and stored on the entry: session/set_config_option
  // rewrites `current` between steps, and installModelSelection applies it at
  // the next step boundary.
  const modelRef: ModelSelectionRef = { current: selection, assembled: undefined }
  entry.modelRef = modelRef
  entry.modelSelectionInstalled = true
  const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, log)
  const preset = await presetFor(deps, mode.kind === 'create'
    ? { kind: 'create', ...mode.agentPreset !== undefined ? { requested: mode.agentPreset } : {} }
    : { kind: 'resume', sessionId: mode.resumeSessionId })
  const setup = async (agentCtx: CordisContext) => {
    installModelSelection(agentCtx, modelRef)
    attachEventBridge(agentCtx, entry, emit, contextWindowResolver(deps, entry))
    attachPermBridge(agentCtx, entry.sessionId, entry, deps.offerAlwaysPermissions, () => entry.client, log)
    attachQuestionBridge(agentCtx, entry, log)
    if (preset !== undefined) await preset.presets.mount(agentCtx, preset.id)
  }
  const handle = mode.kind === 'create'
    ? await deps.agents.create({
        sessionId: SessionId(entry.sessionId),
        // The header's agentPreset seeds the session's preset projection,
        // so a later resume (here or in the GUI) recomposes the same preset.
        meta: { cwd: mode.cwd, ...preset !== undefined ? { agentPreset: preset.id } : {} },
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

/**
 * Attach to a live agent this plugin does not own. Listeners ride the
 * agent's own scope (so dsh-scope filters events to it) and are detached
 * explicitly; the model selection is NOT installed — the owner may have
 * one — until a set_config_option needs it (see {@link ensureModelSelection}).
 */
export function adoptLiveAgent(deps: EntryDeps, entry: AcpSessionEntry, agent: Agent): void {
  const log = deps.log
  entry.agent = agent
  entry.adopted = true
  entry.cwd = (agent.session.header?.cwd as string | undefined) ?? entry.cwd
  const options = agent.options ?? {}
  entry.modelRef = {
    current: options.provider !== undefined && options.model !== undefined
      ? { provider: options.provider, model: options.model, ...options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {} }
      : deps.modelSelection(),
    assembled: undefined,
  }
  const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, log)
  entry.detach.push(
    ...attachEventBridge(agent.ctx, entry, emit, contextWindowResolver(deps, entry)),
    attachPermBridge(agent.ctx, entry.sessionId, entry, deps.offerAlwaysPermissions, () => entry.client, log),
    attachQuestionBridge(agent.ctx, entry, log),
  )
  entry.dispose = async () => {
    for (const stop of entry.detach.splice(0)) {
      try { stop() } catch { /* already gone with the agent scope */ }
    }
  }
  deps.table.add(entry)
  notifyDshChanged(['sessions', 'agents'])
}

/**
 * An adopted entry gets its own model selection only when a client changes
 * the model and no host-side selector (the session controller's
 * `session/selectModel`) is available to do it for the owner.
 */
export function ensureModelSelection(entry: AcpSessionEntry): void {
  if (entry.modelSelectionInstalled) return
  entry.detach.push(installModelSelection(entry.agent.ctx, entry.modelRef))
  entry.modelSelectionInstalled = true
}

export type OpenOutcome = 'reused' | 'adopted' | 'resumed'

/**
 * Make `sessionId` an ACP session of `client`: reuse, adopt, or resume (see
 * the module doc). `rebind: 'always'` takes the session over from whatever
 * connection held it (resume/load: the caller wants to drive it);
 * `'if-unbound'` leaves a session another live connection drives where it
 * is (fire-and-forget dispatch must not steal another client's stream).
 */
export async function openEntry(
  deps: EntryDeps,
  sessionId: string,
  client: AgentContext | undefined,
  options: { cwd?: string; rebind: 'always' | 'if-unbound' },
): Promise<{ entry: AcpSessionEntry; outcome: OpenOutcome }> {
  const existing = deps.table.get(sessionId)
  if (existing !== undefined) {
    if (options.rebind === 'always' || existing.client === undefined) existing.client = client
    return { entry: existing, outcome: 'reused' }
  }
  const live = deps.agents.get(SessionId(sessionId))
  if (live !== undefined) {
    const entry = newEntry(sessionId, options.cwd ?? '/', client)
    adoptLiveAgent(deps, entry, live)
    deps.log(`adopted live session ${sessionId} (owned elsewhere; attach only)`)
    return { entry, outcome: 'adopted' }
  }
  await requirePersistedSession(deps, sessionId)
  const entry = newEntry(sessionId, options.cwd ?? '/', client)
  await createOrResumeEntry(deps, entry, { kind: 'resume', resumeSessionId: sessionId })
  return { entry, outcome: 'resumed' }
}

/**
 * The reason the agent's most recent turn ended, read from its live session
 * log (bounded backward scan). `undefined` when the latest turn has not
 * ended yet or none ran. Authoritative for sessions this server never
 * tracked (GUI-owned, released entries), unlike `entry.lastTurnEnd`.
 */
export function lastTurnEndOf(agent: Agent, maxScan = 2_000): TurnEndReason | undefined {
  const session = agent.session as unknown as { seq: number; eventAt(seq: number): { type: string; data?: unknown } | undefined }
  const end = Number(session.seq)
  for (let seq = end - 1, scanned = 0; seq >= 0 && scanned < maxScan; seq -= 1, scanned += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/end') return (event.data as { reason: TurnEndReason }).reason
    if (event.type === 'turn/start') return undefined
  }
  return undefined
}

/** Whether the entry's agent is mid-turn (or an ACP prompt is in flight). */
export function isRunning(entry: AcpSessionEntry): boolean {
  return entry.prompting || entry.agent.status === 'running'
}

/**
 * Take one entry out of the table. Owned: optionally cancel, drain, and
 * dispose the agent. Adopted: detach only — the owner's turn keeps going.
 */
export async function releaseEntry(deps: EntryDeps, entry: AcpSessionEntry, options: { cancel: boolean }): Promise<void> {
  if (deps.table.get(entry.sessionId) === entry) deps.table.remove(entry.sessionId)
  if (!entry.adopted) {
    if (options.cancel) entry.agent.cancel({ kind: 'user' })
    await entry.agent.whenIdle().catch(() => undefined)
  }
  await entry.dispose()
  notifyDshChanged(['sessions', 'agents'])
}

/**
 * A connection went away. Its sessions lose their client; idle ones are
 * released now, running ones when their turn settles — unless another
 * connection re-opened them in the meantime. A detached task therefore
 * finishes its turn (persisted, readable later) instead of being killed by
 * its dispatcher's exit.
 */
export function releaseConnection(deps: EntryDeps, key: ConnectionKey): void {
  for (const entry of deps.table.list()) {
    if (connectionKeyOf(entry.client) !== key) continue
    entry.client = undefined
    const release = () => {
      if (entry.client !== undefined || deps.table.get(entry.sessionId) !== entry) return
      deps.log(`released session ${entry.sessionId} (its connection closed)`)
      void releaseEntry(deps, entry, { cancel: false }).catch(() => undefined)
    }
    if (!isRunning(entry)) {
      release()
      continue
    }
    deps.log(`connection closed; session ${entry.sessionId} keeps running until its turn settles`)
    void entry.agent.whenIdle().catch(() => undefined).then(() => {
      // An ACP prompt may still be unwinding its finally block.
      setTimeout(release, 0)
    })
  }
}

/** Apply an orchestrator's permission policy to an entry. */
export function setPermissionPolicy(entry: AcpSessionEntry, policy: PermissionPolicy | undefined): void {
  if (policy !== undefined) entry.permissionPolicy = policy
}

// ── config options ─────────────────────────────────────────────────────────

/**
 * The full configOptions state for one session: the model select over every
 * registered provider, plus the reasoning-effort select when the CURRENT
 * route declares efforts. Best-effort by design — a failed catalog read
 * shrinks the option list, it never fails the request carrying it.
 */
export async function configOptionsOf(deps: EntryDeps, entry: AcpSessionEntry) {
  const llm = deps.dshServices().llm
  const current = entry.modelRef.current
  if (llm === undefined || current === undefined) return []
  const options = [buildModelOption(current, await providerCatalogOf(llm))]
  try {
    const info = await llm.resolveModelInfo(current.provider, current.model)
    const reasoning = buildReasoningOption(current, info.reasoning)
    if (reasoning !== undefined) options.push(reasoning)
  } catch { /* unknown route: only the model select is offered */ }
  return options
}

/**
 * Every registered provider with its advertised models; failures shrink it.
 * Both levels carry a soft deadline: an adapter whose catalog read stalls
 * (endpoint interrogation) must not stall the request carrying configOptions.
 */
const CATALOG_DEADLINE_MS = 8_000
const PROVIDER_DEADLINE_MS = 4_000

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([
    promise.finally(() => timer?.unref?.()),
    timeout,
  ])
}

export async function providerCatalogOf(llm: NonNullable<DshServiceSnapshot['llm']>): Promise<ProviderCatalog[]> {
  try {
    const providers = llm.listProviders()
    const groups = await withDeadline(Promise.all(providers.map(async (provider): Promise<ProviderCatalog | undefined> => {
      try {
        const models = await withDeadline(llm.listModels(provider.id), PROVIDER_DEADLINE_MS)
        if (models === undefined) return undefined // deadline: offer this provider later, never stall
        return { id: provider.id, name: provider.name, models: [...models] }
      } catch {
        return undefined // one silent provider must not sink the selector
      }
    })), CATALOG_DEADLINE_MS)
    return (groups ?? []).filter((group): group is ProviderCatalog => group !== undefined)
  } catch {
    return []
  }
}

/**
 * Fail a resume/load BEFORE agents.resume does, so an unknown id surfaces as
 * a precise -32602 instead of the SDK's generic internal-error envelope.
 */
export async function requirePersistedSession(deps: EntryDeps, sessionId: string): Promise<void> {
  const persistence = deps.dshServices().sessionPersistence
  if (persistence === undefined) return // no persistence: resume validation stays with agents.resume
  const stat = await persistence.stat(sessionId).catch(() => undefined)
  if (stat === undefined) {
    throw new RequestError(-32602, `unknown session: ${sessionId} (it has no persisted artifact; use session/list)`)
  }
}

// ── prompt content ─────────────────────────────────────────────────────────

/** The prompt's single text block, if it is exactly one text block. */
export function singleTextOf(prompt: ReadonlyArray<{ type: string; text?: string }> | undefined): string | undefined {
  if (prompt === undefined || prompt.length !== 1 || prompt[0] === undefined) return undefined
  if (prompt[0].type !== 'text') return undefined
  return prompt[0].text
}

/** Fold ACP prompt blocks into dsh content; images persist through attachments. */
export async function resolvePromptContent(deps: EntryDeps, prompt: ReadonlyArray<Record<string, unknown>>): Promise<ReturnType<typeof promptToContent>> {
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

// ── modes and commands ─────────────────────────────────────────────────────

/** ACP modes: the dsh plan-mode seam mapped onto standard session modes. */
export const MODES: Array<{ id: string; name: string; description: string }> = [
  { id: 'default', name: 'Default', description: 'Full agent capabilities' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning mode (dsh plan mode)' },
]

export function modeStateOf(current: 'default' | 'plan') {
  return { currentModeId: current, availableModes: MODES.map((mode) => ({ ...mode })) }
}

/** Current plan-mode id, defaulting to 'default' without the service. */
export function planIdOf(deps: EntryDeps, entry: AcpSessionEntry): 'default' | 'plan' {
  const planMode = deps.dshServices().planMode
  if (planMode === undefined) return 'default'
  return planMode.get(entry.agent)?.active === true ? 'plan' : 'default'
}

/** Notify a mode change when it differs from the entry's last advertised id. */
export function emitModeChange(deps: EntryDeps, entry: AcpSessionEntry): void {
  const current = planIdOf(deps, entry)
  if (entry.modeId === current) return
  entry.modeId = current
  const emit = makeEmitter(entry.sessionId, { context: () => entry.client }, deps.log)
  emit({ sessionUpdate: 'current_mode_update', currentModeId: current })
}

/** Advertise slash commands (available_commands_update) for one session. */
export function advertise(deps: EntryDeps, entry: AcpSessionEntry): void {
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

export function requireEntry(deps: EntryDeps, sessionId: string): AcpSessionEntry {
  const entry = deps.table.get(sessionId)
  if (entry === undefined) throw new RequestError(-32602, `unknown session: ${sessionId} (not open on this server; session/resume it first)`)
  return entry
}
