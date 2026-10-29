/**
 * The Peer that host-control calls speak for.
 *
 * dsh 0.2.1 made `peer` mandatory on every gateway request: the gateway reads
 * `request.peer.signal` before dispatch, so a peer-less `invoke`/`stream`
 * failed with "Cannot read properties of undefined (reading 'signal')".
 * Browser requests get the web server's owner Peer, but the bare ACP profile
 * mounts no connection service, so this module builds the same thing
 * dsh-client-connection's `Peer` does: an owner principal on a dsh-scope fiber
 * under the plugin context, aborted when that context disposes.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from 'node:crypto'
import type { GatewayLike, GatewayRequest } from './host-control.js'

/**
 * Create one owner Peer under `ctx`.
 * @param ctx - plugin context; disposing it disposes the Peer.
 * @returns the live Peer.
 */
export function createOwnerPeer(ctx: Context): PeerScope {
  const lifetime = new AbortController()
  const peer = {
    id: randomUUID(),
    principal: { kind: 'owner' as const },
    // ACP clients never answer forwarded Host events (permission prompts
    // travel over ACP itself), so the Peer does not claim that role.
    interactions: 'none' as const,
    signal: lifetime.signal,
  } as { -readonly [K in keyof PeerScope]: PeerScope[K] }
  const scope = createScope(ctx, peer)
  peer.ctx = scope.ctx
  peer.dispose = () => scope.dispose()
  scope.ctx.effect(() => () => {
    lifetime.abort(new Error(`Peer ${peer.id} was disposed`))
  }, 'dsh-acp: owner Peer lifetime')
  return peer
}

/**
 * Bind a lazily resolved gateway to one owner Peer created on first use.
 * Callers keep the peer-less request shape; a request that already names a
 * Peer keeps it.
 * @param ctx - plugin context that owns the Peer.
 * @param gateway - resolves the live `typertGateway`, or `undefined`.
 * @returns the same resolver, with `peer` filled into every request.
 */
export function withOwnerPeer(
  ctx: Context,
  gateway: () => GatewayLike | undefined,
): () => GatewayLike | undefined {
  let peer: PeerScope | undefined
  const bound = new WeakMap<GatewayLike, GatewayLike>()
  const scoped = (request: GatewayRequest): GatewayRequest => ({ ...request, peer: request.peer ?? (peer ??= createOwnerPeer(ctx)) })
  return () => {
    const raw = gateway()
    if (raw === undefined) return undefined
    let wrapped = bound.get(raw)
    if (wrapped === undefined) {
      wrapped = {
        wireStream: raw.wireStream,
        invoke: (request) => raw.invoke(scoped(request)),
        stream: (request) => raw.stream(scoped(request)),
      }
      bound.set(raw, wrapped)
    }
    return wrapped
  }
}
