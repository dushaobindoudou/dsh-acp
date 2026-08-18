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

/** The capability key inside `clientCapabilities._meta`. */
export const DSH_EXTENSIONS_KEY = 'dsh/extensions'

/** Topics carried by `dsh/changed` notifications. */
export type DshChangedTopic = 'sessions' | 'jobs' | 'goals' | 'agents' | 'skills'

// ── opt-in registry ────────────────────────────────────────────────────────

const extensionClients = new Set<AgentContext>()

/**
 * Record one connection's extension opt-in from its `initialize` params.
 * Returns whether the connection opted in.
 */
export function registerExtensionClient(
  client: AgentContext | undefined,
  params: { clientCapabilities?: { _meta?: Record<string, unknown> } },
): boolean {
  if (client === undefined) return false
  const meta = params.clientCapabilities?._meta
  const optedIn = meta !== undefined && Boolean(meta[DSH_EXTENSIONS_KEY])
  if (optedIn) extensionClients.add(client)
  else extensionClients.delete(client)
  return optedIn
}

/**
 * Fire-and-forget `dsh/changed` dirty signal to every opted-in connection.
 * A rejected delivery means the connection is gone (closed HTTP connection
 * or ended stdio stream) and prunes the entry.
 */
export function notifyDshChanged(topics: readonly DshChangedTopic[]): void {
  for (const client of extensionClients) {
    client.notify('dsh/changed', { topics: [...topics] })
      .catch(() => {
        extensionClients.delete(client)
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
    list(): ReadonlyArray<{
      id: string; kind: string; label: string; status: string
      ownerSession?: string; startedAt: number; finishedAt?: number
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
      options?: { provider?: string; model?: string }
      session?: { header?: { cwd?: string; parentSession?: string } }
    }>
  }
}

export interface DshExtensionDeps {
  /** Resolve services fresh per request (they come and go with the fiber). */
  readonly services: () => DshServiceSnapshot
  /** Live ACP session ids (as dsh session ids) currently open here. */
  readonly openDshSessionIds: () => ReadonlySet<string>
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
  handler: (rc: { params?: unknown; client?: AgentContext | undefined }) => Promise<unknown>,
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
      const limitRaw = (params as { limit?: unknown }).limit
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
  onVendorRequest(app, 'dsh/jobs/list', async () => {
      const jobs = deps.services().jobs
      if (jobs === undefined) throw unavailable('dsh/jobs/list', 'jobs')
      return {
        jobs: jobs.list().map((job) => ({
          id: job.id, kind: job.kind, label: job.label, status: job.status,
          ownerSession: job.ownerSession, startedAt: job.startedAt, finishedAt: job.finishedAt,
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
        agents: agentsService.list().map((liveAgent) => ({
          sessionId: liveAgent.id,
          provider: liveAgent.options?.provider,
          model: liveAgent.options?.model,
          cwd: liveAgent.session?.header?.cwd,
          parentSession: liveAgent.session?.header?.parentSession,
          acp: open.has(liveAgent.id),
        })),
      }
    })
  return app
}
