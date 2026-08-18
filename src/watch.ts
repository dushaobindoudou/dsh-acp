/**
 * Session watch registry: `dsh/sessions/watch` support.
 *
 * A watcher (any ACP connection) subscribes to one dsh session's translated
 * event stream and receives `dsh/session/update {sessionId, update}` frames -
 * the same SessionUpdate shapes the owning client gets, so dashboards and
 * orchestrators can observe a conversation they did not start.
 *
 * Two feeds converge here:
 *  - sessions hosted by THIS plugin: event-bridge calls notifyWatchers per
 *    agent-scoped event (always fires);
 *  - sessions created elsewhere in the process (e.g. the web GUI in
 *    web-mounted mode): the plugin-fiber-level `session/event` listener in
 *    index.ts calls dispatchGlobalSessionEvent, whose delivery depends on the
 *    harness's event scoping.
 */
import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk'
import { notifyDshChanged } from './dsh-extensions.js'

type Translator = (event: unknown) => SessionUpdate | null

/** Injected at boot from event-bridge (keeps this module cycle-free). */
let translate: Translator = () => null
export function setWatchTranslator(translator: Translator): void {
  translate = translator
}

const watchers = new Map<string, Set<AgentContext>>()

export function watchSession(sessionId: string, client: AgentContext | undefined): boolean {
  if (client === undefined) return false
  let set = watchers.get(sessionId)
  if (set === undefined) {
    set = new Set()
    watchers.set(sessionId, set)
  }
  const isNew = !set.has(client)
  set.add(client)
  return isNew
}

export function unwatchSession(sessionId: string, client: AgentContext | undefined): void {
  if (client === undefined) return
  const set = watchers.get(sessionId)
  if (set === undefined) return
  set.delete(client)
  if (set.size === 0) watchers.delete(sessionId)
}

/** Forward one event of a watched session to every watcher connection. */
export function notifyWatchers(sessionId: string, event: unknown): void {
  const set = watchers.get(sessionId)
  if (set === undefined || set.size === 0) return
  let update: SessionUpdate | null
  try {
    update = translate(event)
  } catch {
    return
  }
  if (update === null) return
  for (const client of set) {
    client.notify('dsh/session/update', { sessionId, update })
      .catch(() => {
        // Dead connection: stop delivering to it.
        set.delete(client)
      })
      .catch(() => undefined)
  }
}

// Live agent-tree signal: coalesced dsh/changed {agents} on agent/status.
let agentsSignalAt = 0
let agentsSignalTimer: ReturnType<typeof setTimeout> | undefined

function signalAgentsChanged(): void {
  const now = Date.now()
  if (now - agentsSignalAt < 1000) {
    if (agentsSignalTimer === undefined) {
      agentsSignalTimer = setTimeout(() => {
        agentsSignalTimer = undefined
        agentsSignalAt = Date.now()
        notifyDshChanged(['agents'])
      }, 1000)
    }
    return
  }
  agentsSignalAt = now
  notifyDshChanged(['agents'])
}

/** Plugin-fiber feed for sessions this plugin did not create. */
export function dispatchGlobalSessionEvent(session: { id?: string } | undefined, event: unknown): void {
  const sessionId = session?.id
  if (sessionId === undefined) return
  if ((event as { type?: string } | null)?.type === 'agent/status') signalAgentsChanged()
  notifyWatchers(sessionId, event)
}
