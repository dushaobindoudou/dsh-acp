/**
 * ACP connection identity and lifecycle.
 *
 * The SDK hands every request handler a FRESH `AgentContext` wrapping the
 * connection's shared context, so object identity of `client` says nothing
 * about which connection a request came from. Everything that must
 * recognize "the same connection" across requests (session ownership,
 * watchers, remote streams, declared capabilities) keys on
 * {@link connectionKeyOf} instead.
 */
import type { AgentConnection, AgentContext } from '@agentclientprotocol/sdk'

/** Opaque per-connection identity. */
export type ConnectionKey = object

/** The shared connection context behind any per-request `AgentContext`. */
export function connectionKeyOf(client: AgentContext | undefined): ConnectionKey | undefined {
  if (client === undefined) return undefined
  // `connectionContext` is SDK-internal (typed @internal) but stable across
  // 1.x; fall back to the wrapper itself so a future rename degrades to the
  // old per-object identity instead of throwing.
  return (client as unknown as { connectionContext?: object }).connectionContext ?? client
}

/** Whether two request contexts belong to the same connection. */
export function sameConnection(a: AgentContext | undefined, b: AgentContext | undefined): boolean {
  const left = connectionKeyOf(a)
  return left !== undefined && left === connectionKeyOf(b)
}

/** The capability slice the server branches on (initialize params). */
export interface DeclaredCapabilities {
  readonly elicitation?: { readonly form?: unknown } | null
  readonly _meta?: Record<string, unknown> | null
}

const capabilities = new WeakMap<ConnectionKey, DeclaredCapabilities>()

/** Record the capabilities one connection declared in `initialize`. */
export function recordCapabilities(client: AgentContext | undefined, declared: DeclaredCapabilities | undefined): void {
  const key = connectionKeyOf(client)
  if (key !== undefined) capabilities.set(key, declared ?? {})
}

/** Whether the connection declared form-mode elicitation support. */
export function supportsFormElicitation(client: AgentContext | undefined): boolean {
  const key = connectionKeyOf(client)
  const elicitation = key === undefined ? undefined : capabilities.get(key)?.elicitation
  return elicitation !== undefined && elicitation !== null && elicitation.form !== undefined && elicitation.form !== null
}

type CloseListener = (key: ConnectionKey) => void
const closeListeners = new Set<CloseListener>()

/** Observe connection teardown (stdio EOF, HTTP DELETE, dropped transport). */
export function onConnectionClosed(listener: CloseListener): () => void {
  closeListeners.add(listener)
  return () => {
    closeListeners.delete(listener)
  }
}

/** Fire close listeners once when the SDK connection settles. */
export function trackConnection(connection: AgentConnection): void {
  const key = connectionKeyOf(connection.client)
  if (key === undefined) return
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    for (const listener of [...closeListeners]) {
      try {
        listener(key)
      } catch {
        // One listener's cleanup failure must not skip the others.
      }
    }
  }
  connection.closed.then(fire, fire)
}
