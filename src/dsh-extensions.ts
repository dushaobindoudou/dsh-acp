/**
 * dsh/* vendor extensions for ACP.
 *
 * ACP v1 has no standard surface for host concepts beyond one conversation:
 * session history, background jobs, goals, skills, or the live agent tree.
 * These read-only request methods expose them under the `dsh/` method
 * namespace so our own clients (the built-in web UI, acp-chat) - and any
 * third-party client that wants to - can render them.
 *
 * Interop rules:
 * - Standard clients are untouched: unknown methods are simply never called,
 *   and `dsh/changed` notifications are ONLY sent to connections that opted
 *   in through the schema-sanctioned extension point
 *   `initialize.params.clientCapabilities._meta['dsh/extensions']`
 *   (the `_meta` record is part of the official ClientCapabilities schema).
 * - Every service is resolved lazily and treated as optional: a composition
 *   without e.g. the goals service gets a clean -32601 for that one method.
 * - All payloads are plain, owned JSON - no live service objects cross the
 *   wire.
 */
import { RequestError } from '@agentclientprotocol/sdk'
import type { AgentApp, AgentContext } from '@agentclientprotocol/sdk'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import { watchSession, unwatchSession } from './watch.js'
import { connectionKeyOf, onConnectionClosed, type ConnectionKey } from './connections.js'

/** The capability key inside `clientCapabilities._meta`. */
export const DSH_EXTENSIONS_KEY = 'dsh/extensions'

/** Topics carried by `dsh/changed` notifications. */
export type DshChangedTopic = 'sessions' | 'jobs' | 'goals' | 'agents' | 'skills'

// ── opt-in registry ────────────────────────────────────────────────────────

const extensionClients = new Map<ConnectionKey, AgentContext>()
onConnectionClosed((key) => {
  extensionClients.delete(key)
})

/**
 * Record one connection's extension opt-in from its `initialize` params.
 * Returns whether the connection opted in.
 */
export function registerExtensionClient(
  client: AgentContext | undefined,
  params: { clientCapabilities?: { _meta?: Record<string, unknown> | null } },
): boolean {
  const key = connectionKeyOf(client)
  if (client === undefined || key === undefined) return false
  const meta = params.clientCapabilities?._meta
  const optedIn = meta !== undefined && meta !== null && Boolean(meta[DSH_EXTENSIONS_KEY])
  if (optedIn) extensionClients.set(key, client)
  else extensionClients.delete(key)
  return optedIn
}

/**
 * Fire-and-forget `dsh/changed` dirty signal to every opted-in connection.
 * A rejected delivery means the connection is gone (closed HTTP connection
 * or ended stdio stream) and prunes the entry.
 */
export function notifyDshChanged(topics: readonly DshChangedTopic[]): void {
  for (const [key, client] of extensionClients) {
    client.notify('dsh/changed', { topics: [...topics] })
      .catch(() => {
        extensionClients.delete(key)
      })
      .catch(() => undefined)
  }
}

// ── service host seam ──────────────────────────────────────────────────────

/** Lazily resolved dsh services (all optional; compositions vary). */
export interface DshServiceSnapshot {
  readonly sessionQuery?: {
    listSessions(signal?: AbortSignal): Promise<
      ReadonlyArray<{ header: { id: string; createdAt: number; cwd?: string; parentSession?: string }; live: boolean; persisted: boolean }>
    >
    readSurface(sessionId: string): Promise<{
      events: ReadonlyArray<{ seq?: number; type: string } & Record<string, unknown>>
    }>
    readTitleSnapshots(
      sessionIds: readonly string[],
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<{ sessionId: string } & (
      | { status: 'fulfilled'; value: { session: { id: string }; title?: { title: string } } }
      | { status: 'rejected'; reason?: unknown }
    )>>
  }
  readonly jobs?: {
    /** dsh 0.2 JobView: `owner` (was `ownerSession`), plus progress/detail lines. */
    list(): ReadonlyArray<{
      id: string; kind: string; label: string; status: string
      owner?: string; progress?: string; detail?: string
      startedAt: number; finishedAt?: number
    }>
  }
  readonly goals?: {
    get(agent: { id: string }): {
      objective: string; phase: string; maxGoalRounds: number
      roundsStarted: number; createdAt: number; updatedAt: number
      blockedReason?: unknown
    } | undefined
  }
  readonly skills?: {
    list(): Promise<ReadonlyArray<{
      name: string; description: string; whenToUse?: string
      provider: string; source?: unknown
    }>>
  }
  readonly agents?: {
    list(): ReadonlyArray<{
      id: string
      status?: string
      options?: { provider?: string; model?: string }
      session?: { header?: { cwd?: string; parentSession?: string } }
    }>
  }
  readonly planMode?: {
    get(agent: { id: string }): { active: boolean } | undefined
    set(agent: unknown, active: boolean): string
  }
  readonly commands?: {
    list(agent: unknown): ReadonlyArray<{ name: string; description: string }>
    /**
     * dsh >= 0.1.2-rc.1 takes composer images between the line and the
     * signal. The registry reads `signal.aborted` unguarded, so the old
     * 3-argument form lands the signal in `images` and throws
     * "Cannot read properties of undefined (reading 'aborted')" before the
     * command handler ever runs.
     */
    execute(agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal): Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>
  }
  /** Model/provider registry backing session/set_config_option and usage updates. */
  readonly llm?: {
    listProviders(): ReadonlyArray<{ id: string; name: string }>
    listModels(provider: string): Promise<ReadonlyArray<{ id: string; name: string; description?: string }>>
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
      context?: { contextWindow: number }
      reasoning?: { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort?: string }
    }>
  }
  /** Durable session storage backing session/delete (stat + cross-process write claim). */
  readonly sessionPersistence?: {
    stat(id: string, options?: { signal?: AbortSignal }): Promise<unknown>
    open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{ close(): Promise<void> }>
    /** The JSONL backend exposes its root (`$DSH_HOME/sessions` by default). */
    readonly config?: { readonly root?: string }
  }
}

export interface DshExtensionDeps {
  /** Resolve services fresh per request (they come and go with the fiber). */
  readonly services: () => DshServiceSnapshot
  /** Live ACP session ids (as dsh session ids) currently open here. */
  readonly openDshSessionIds: () => ReadonlySet<string>
  /** The ACP table entry of a session, when it is open here. */
  readonly entryOf?: (sessionId: string) => { adopted: boolean; permissionPolicy: string; client: unknown } | undefined
  readonly log: (message: string) => void
}

function unavailable(method: string, service: string): RequestError {
  return new RequestError(-32601, `${method} unavailable: this composition provides no ${service} service`)
}

// ── registration ───────────────────────────────────────────────────────────

/**
 * Register a vendor request method. The SDK types `onRequest` as a closed
 * union of standard ACP methods; runtime dispatch is a plain method-string
 * map, so arbitrary `dsh/*` names work - this helper only loosens the type.
 */
export function onVendorRequest(
  app: AgentApp,
  method: string,
  handler: (rc: { params?: unknown; client?: AgentContext | undefined; signal?: AbortSignal }) => Promise<unknown>,
): void {
  // The SDK requires a params parser for non-standard methods; a pass-through
  // keeps validation in the handlers themselves (they already reject bad
  // shapes with precise -32602 messages).
  ;(app as unknown as {
    onRequest: (
      name: string,
      parser: (params: unknown) => unknown,
      fn: (rc: never) => unknown,
    ) => unknown
  }).onRequest(method, (params: unknown) => params, handler as (rc: never) => unknown)
}

function dshWatchHandlers(app: AgentApp): void {
  onVendorRequest(app, 'dsh/sessions/watch', async ({ params, client }) => {
    const sessionId = (params as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RequestError(-32602, 'dsh/sessions/watch requires a sessionId')
    }
    watchSession(sessionId, client)
    return { sessionId, watching: true }
  })
  onVendorRequest(app, 'dsh/sessions/unwatch', async ({ params, client }) => {
    const sessionId = (params as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RequestError(-32602, 'dsh/sessions/unwatch requires a sessionId')
    }
    unwatchSession(sessionId, client)
    return { sessionId, watching: false }
  })
}

/** Attach every read-only `dsh/*` request handler to an agent builder. */
export function attachDshExtensions(app: AgentApp, deps: DshExtensionDeps): AgentApp {
  onVendorRequest(app, 'dsh/sessions/list', async () => {
      const query = deps.services().sessionQuery
      if (query === undefined) throw unavailable('dsh/sessions/list', 'sessionQuery')
      const records = await query.listSessions()
      const titles = new Map<string, string>()
      try {
        const observations = await query.readTitleSnapshots(records.map((record) => record.header.id))
        for (const observation of observations) {
          if ('value' in observation && observation.value.title !== undefined) {
            titles.set(observation.sessionId, observation.value.title.title)
          }
        }
      } catch (error) {
        deps.log(`dsh/sessions/list: titles unavailable (${String(error instanceof Error ? error.message : error)})`)
      }
      const open = deps.openDshSessionIds()
      return {
        sessions: records
          .map((record) => ({
            id: record.header.id,
            createdAt: record.header.createdAt,
            cwd: record.header.cwd,
            parentSession: record.header.parentSession,
            live: record.live,
            persisted: record.persisted,
            title: titles.get(record.header.id),
            acp: open.has(record.header.id),
          }))
          .sort((a, b) => b.createdAt - a.createdAt),
      }
    })
  onVendorRequest(app, 'dsh/sessions/read', async ({ params }) => {
      const query = deps.services().sessionQuery
      if (query === undefined) throw unavailable('dsh/sessions/read', 'sessionQuery')
      const sessionId = (params as { sessionId?: unknown }).sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new RequestError(-32602, 'dsh/sessions/read requires a sessionId')
      }
      const limitRaw = (params as { limit?: unknown } | undefined)?.limit
      const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 1000)
        : 200
      const surface = await query.readSurface(sessionId)
      const entries: Array<{ seq: number; type: string; text: string }> = []
      for (const [index, event] of [...surface.events].entries()) {
        let text = ''
        try {
          text = extractSessionEventText(event as never).trim()
        } catch {
          text = ''
        }
        if (text.length === 0) continue
        entries.push({ seq: typeof event.seq === 'number' ? event.seq : index, type: event.type, text })
      }
      return { sessionId, entries: entries.slice(-limit) }
    })
  onVendorRequest(app, 'dsh/sessions/search', async ({ params }) => {
      const query = deps.services().sessionQuery
      if (query === undefined) throw unavailable('dsh/sessions/search', 'sessionQuery')
      const text = (params as { query?: unknown } | undefined)?.query
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new RequestError(-32602, 'dsh/sessions/search requires a non-empty query')
      }
      const needle = text.trim().toLocaleLowerCase()
      const limitRaw = (params as { limit?: unknown } | undefined)?.limit
      const limit = typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 100) : 50
      const records = await query.listSessions()
      const titles = new Map<string, string>()
      try {
        for (const observation of await query.readTitleSnapshots(records.map((record) => record.header.id))) {
          if ('value' in observation && observation.value.title !== undefined) {
            titles.set(observation.sessionId, observation.value.title.title)
          }
        }
      } catch { /* Search still works on ids and cwd when title reads fail. */ }
      const matches = records
        .filter((record) => [record.header.id, record.header.cwd ?? '', titles.get(record.header.id) ?? '']
          .some((field) => field.toLocaleLowerCase().includes(needle)))
        .sort((a, b) => b.header.createdAt - a.header.createdAt)
      return {
        sessions: matches.slice(0, limit).map((record) => ({
          id: record.header.id,
          title: titles.get(record.header.id),
          cwd: record.header.cwd,
          parentSession: record.header.parentSession,
          createdAt: record.header.createdAt,
          live: record.live,
          persisted: record.persisted,
        })),
        hasMore: matches.length > limit,
      }
    })
  onVendorRequest(app, 'dsh/jobs/list', async () => {
      const jobs = deps.services().jobs
      if (jobs === undefined) throw unavailable('dsh/jobs/list', 'jobs')
      return {
        jobs: jobs.list().map((job) => ({
          id: job.id, kind: job.kind, label: job.label, status: job.status,
          // `ownerSession` stays on the wire for existing clients (webui.html).
          ownerSession: job.owner, progress: job.progress, detail: job.detail,
          startedAt: job.startedAt, finishedAt: job.finishedAt,
        })),
      }
    })
  onVendorRequest(app, 'dsh/goals/list', async () => {
      const { goals, agents } = deps.services()
      if (goals === undefined || agents === undefined) throw unavailable('dsh/goals/list', 'goals')
      const live = agents.list()
      return {
        goals: live.flatMap((liveAgent) => {
          const view = goals.get(liveAgent)
          if (view === undefined) return []
          return [{
            sessionId: liveAgent.id,
            objective: view.objective,
            phase: view.phase,
            maxGoalRounds: view.maxGoalRounds,
            roundsStarted: view.roundsStarted,
            createdAt: view.createdAt,
            updatedAt: view.updatedAt,
            blockedReason: view.blockedReason,
          }]
        }),
      }
    })
  onVendorRequest(app, 'dsh/skills/list', async () => {
      const skills = deps.services().skills
      if (skills === undefined) throw unavailable('dsh/skills/list', 'skills')
      return {
        skills: (await skills.list()).map((skill) => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          provider: skill.provider,
          source: skill.source,
        })),
      }
    })
  onVendorRequest(app, 'dsh/agents/tree', async () => {
      const agentsService = deps.services().agents
      if (agentsService === undefined) throw unavailable('dsh/agents/tree', 'agents')
      const open = deps.openDshSessionIds()
      return {
        agents: agentsService.list().map((liveAgent) => {
          const entry = deps.entryOf?.(liveAgent.id)
          return {
            sessionId: liveAgent.id,
            // idle | running: an orchestrator's "which of my tasks are done".
            status: liveAgent.status,
            provider: liveAgent.options?.provider,
            model: liveAgent.options?.model,
            cwd: liveAgent.session?.header?.cwd,
            parentSession: liveAgent.session?.header?.parentSession,
            acp: open.has(liveAgent.id),
            ...entry !== undefined
              ? { adopted: entry.adopted, permissionPolicy: entry.permissionPolicy, attached: entry.client !== undefined }
              : {},
          }
        }),
      }
    })
  dshWatchHandlers(app)
  return app
}
