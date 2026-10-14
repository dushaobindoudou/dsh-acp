/**
 * The host-control plane: every Remote method dsh exposes to its own GUI,
 * callable over ACP.
 *
 * The web GUI does not reach dsh through bespoke endpoints — it calls Typert
 * Remote methods (`workspace/create`, `session/search`, `settings/update`,
 * `schedule/update`, `pluginManager/installBundle`, …) through the
 * `typertGateway` dispatcher. This module puts the same dispatcher behind
 * four vendor methods, so an ACP client (an orchestrator, a script, another
 * agent) can do everything a user can do in the GUI, and keeps up with new
 * dsh releases without a line of code here:
 *
 *   dsh/remote/catalog  live method list with parameter/result JSON Schemas
 *   dsh/remote/invoke   one unary call            -> { result }
 *   dsh/remote/stream   open a stream method      -> { streamId }
 *                       items: dsh/remote/item {streamId, seq, item}
 *                       end:   dsh/remote/end  {streamId, reason, error?}
 *   dsh/remote/cancel   cancel an open stream
 *
 * Calls run in-process as the operator (no Peer), exactly like a local
 * carrier. `hostControl: false` removes the plane; `hostControlDeny` refuses
 * selected endpoints (`ns/*`, `ns/method`).
 */
import { RequestError } from '@agentclientprotocol/sdk'
import type { AgentApp, AgentContext } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { onVendorRequest } from './dsh-extensions.js'
import { connectionKeyOf, onConnectionClosed, type ConnectionKey } from './connections.js'
import {
  argsOf,
  catalogEntryOf,
  endpointMatches,
  methodDocsOf,
  parseEndpoint,
  remoteFailureHint,
  rpcCodeOfRemote,
  toWire,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type DescriptorLike,
  type Endpoint,
  type PackageModelLike,
} from './wire.js'

/** The slice of `ctx.typertGateway` this plane drives. */
export interface GatewayLike {
  readonly wireStream: { failure(error: unknown): { code: string; message: string; details: object } }
  invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
  stream(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
}

/** The slice of `ctx.typert` (the Typert registry) the catalog reads. */
export interface TypertLike {
  readonly local: { list(): readonly DescriptorLike[]; get(endpoint: string): DescriptorLike | undefined }
  listPackages(filter?: { face?: 'host' | 'client' }): readonly PackageModelLike[]
}

export interface HostControlDeps {
  readonly gateway: () => GatewayLike | undefined
  readonly typert: () => TypertLike | undefined
  readonly serviceAvailable: (name: string) => boolean
  /** Endpoint patterns refused before dispatch (`ns/*`, `ns/method`, `*`). */
  readonly deny: readonly string[]
  readonly log: (message: string) => void
}

interface OpenStream {
  readonly key: ConnectionKey | undefined
  readonly controller: AbortController
  readonly endpoint: string
}

/** Attach the `dsh/remote/*` plane to an agent builder. */
export function attachHostControl(app: AgentApp, deps: HostControlDeps): void {
  const streams = new Map<string, OpenStream>()

  onConnectionClosed((key) => {
    for (const [streamId, open] of streams) {
      if (open.key !== key) continue
      open.controller.abort(new Error('connection closed'))
      streams.delete(streamId)
    }
  })

  const requireGateway = (method: string): GatewayLike => {
    const gateway = deps.gateway()
    if (gateway === undefined) throw new RequestError(RPC_METHOD_NOT_FOUND, `${method} unavailable: this composition provides no typertGateway service`)
    return gateway
  }

  const target = (method: string, params: unknown): { endpoint: Endpoint; args: Record<string, unknown> } => {
    const endpoint = parseEndpoint(params)
    if (typeof endpoint === 'string') throw new RequestError(RPC_INVALID_PARAMS, `${method}: ${endpoint}`)
    if (endpointMatches(endpoint.endpoint, deps.deny)) {
      throw new RequestError(RPC_METHOD_NOT_FOUND, `${endpoint.endpoint} is refused by this server's hostControlDeny policy`)
    }
    const args = argsOf(params)
    if (typeof args === 'string') throw new RequestError(RPC_INVALID_PARAMS, `${method}: ${args}`)
    return { endpoint, args }
  }

  // The Typert loader can publish descriptors before their owning Cordis
  // services finish mounting. Wait for that short startup window so a client
  // can invoke immediately after initialize without an intermittent -32601.
  const waitForTarget = async (endpoint: string, signal?: AbortSignal): Promise<void> => {
    const service = deps.typert()?.local.get(endpoint)?.service
    if (service === undefined || deps.serviceAvailable(service)) return
    const deadline = Date.now() + 5_000
    while (!deps.serviceAvailable(service) && Date.now() < deadline) {
      if (signal?.aborted) throw new RequestError(-32800, `${endpoint}: request cancelled`)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
  }

  onVendorRequest(app, 'dsh/remote/catalog', async ({ params }) => {
    const typert = deps.typert()
    if (typert === undefined) throw new RequestError(RPC_METHOD_NOT_FOUND, 'dsh/remote/catalog unavailable: this composition provides no typert registry')
    const record = (params ?? {}) as { namespace?: unknown; endpoint?: unknown; schemas?: unknown }
    const namespaces = typeof record.namespace === 'string'
      ? [record.namespace]
      : Array.isArray(record.namespace) ? record.namespace.filter((value): value is string => typeof value === 'string') : undefined
    const only = typeof record.endpoint === 'string' ? record.endpoint : undefined
    // Schemas are opt-in (or implied by a narrowed query): the full catalog
    // with every schema is large, and an orchestrator usually lists first.
    const withSchemas = record.schemas === true || (record.schemas !== false && (only !== undefined || namespaces !== undefined))
    let docs: Map<string, string>
    try {
      docs = methodDocsOf(typert.listPackages({ face: 'host' }))
    } catch {
      docs = new Map()
    }
    const methods = typert.local.list()
      .filter((descriptor) => namespaces === undefined || namespaces.includes(descriptor.namespace))
      .filter((descriptor) => only === undefined || `${descriptor.namespace}/${descriptor.method}` === only)
      .filter((descriptor) => !endpointMatches(`${descriptor.namespace}/${descriptor.method}`, deps.deny))
      .map((descriptor) => ({ ...catalogEntryOf(descriptor, docs, withSchemas), available: deps.serviceAvailable(descriptor.service) }))
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    const counts = new Map<string, number>()
    for (const method of methods) counts.set(method.namespace, (counts.get(method.namespace) ?? 0) + 1)
    return {
      methods,
      namespaces: [...counts].map(([namespace, count]) => ({ namespace, methods: count })),
    }
  })

  onVendorRequest(app, 'dsh/remote/invoke', async ({ params, signal }) => {
    const gateway = requireGateway('dsh/remote/invoke')
    const { endpoint, args } = target('dsh/remote/invoke', params)
    await waitForTarget(endpoint.endpoint, signal)
    try {
      const result = await gateway.invoke({ namespace: endpoint.namespace, method: endpoint.method, args, signal })
      return { result: toWire(result) ?? null }
    } catch (error) {
      throw toRequestError(gateway, error, endpoint.endpoint)
    }
  })

  onVendorRequest(app, 'dsh/remote/stream', async ({ params, client, signal }) => {
    const gateway = requireGateway('dsh/remote/stream')
    if (client === undefined) throw new RequestError(RPC_INVALID_PARAMS, 'dsh/remote/stream needs a connection to deliver items to')
    const { endpoint, args } = target('dsh/remote/stream', params)
    await waitForTarget(endpoint.endpoint, signal)
    // A client-chosen id lets the client register its item handler BEFORE
    // the request goes out: items may be written ahead of this response.
    const requested = (params as { streamId?: unknown } | undefined)?.streamId
    if (requested !== undefined && (typeof requested !== 'string' || requested.length === 0 || requested.length > 128)) {
      throw new RequestError(RPC_INVALID_PARAMS, 'streamId must be a non-empty string of at most 128 characters')
    }
    const streamId = typeof requested === 'string' ? requested : `rs-${randomUUID()}`
    if (streams.has(streamId)) throw new RequestError(RPC_INVALID_PARAMS, `stream ${streamId} is already open`)
    const controller = new AbortController()
    let iterable: AsyncIterable<unknown>
    try {
      iterable = await gateway.stream({ namespace: endpoint.namespace, method: endpoint.method, args, signal: controller.signal })
    } catch (error) {
      throw toRequestError(gateway, error, endpoint.endpoint)
    }
    streams.set(streamId, { key: connectionKeyOf(client), controller, endpoint: endpoint.endpoint })
    setTimeout(() => void pump(gateway, streamId, endpoint.endpoint, iterable, client, controller), 0)
    return { streamId }
  })

  onVendorRequest(app, 'dsh/remote/cancel', async ({ params, client }) => {
    const streamId = (params as { streamId?: unknown } | undefined)?.streamId
    if (typeof streamId !== 'string') throw new RequestError(RPC_INVALID_PARAMS, 'dsh/remote/cancel requires a streamId')
    const open = streams.get(streamId)
    if (open === undefined || open.key !== connectionKeyOf(client)) return { streamId, cancelled: false }
    open.controller.abort(new Error('cancelled by the client'))
    return { streamId, cancelled: true }
  })

  async function pump(
    gateway: GatewayLike,
    streamId: string,
    endpoint: string,
    iterable: AsyncIterable<unknown>,
    client: AgentContext,
    controller: AbortController,
  ): Promise<void> {
    let seq = 0
    let end: { reason: 'done' | 'cancelled' | 'error'; error?: unknown } = { reason: 'done' }
    try {
      for await (const item of iterable) {
        if (controller.signal.aborted) break
        try {
          await client.notify('dsh/remote/item', { streamId, seq, item: toWire(item) ?? null })
        } catch {
          // The connection is gone: stop pulling from the host stream.
          controller.abort(new Error('connection closed'))
          break
        }
        seq += 1
      }
      if (controller.signal.aborted) end = { reason: 'cancelled' }
    } catch (error) {
      end = controller.signal.aborted
        ? { reason: 'cancelled' }
        : { reason: 'error', error: failureOf(gateway, error) }
      if (end.reason === 'error') deps.log(`dsh/remote/stream ${endpoint} failed: ${(end.error as { message?: string }).message ?? 'unknown'}`)
    } finally {
      streams.delete(streamId)
      // A dead connection rejects this too; the catch makes that a no-op.
      void client.notify('dsh/remote/end', { streamId, seq, ...end }).catch(() => undefined)
    }
  }
}

/** The carrier-safe failure fields, keeping internal messages for the local operator. */
function failureOf(gateway: GatewayLike, error: unknown): { code: string; message: string; details: unknown } {
  let failure: { code: string; message: string; details: object }
  try {
    failure = gateway.wireStream.failure(error)
  } catch {
    failure = { code: 'internal', message: 'unknown failure', details: {} }
  }
  // The Gateway redacts internal failures for untrusted Peers; this caller
  // is the operator, and a generic "internal" message is useless to it.
  const message = failure.code === 'internal' && error instanceof Error ? error.message : failure.message
  return { code: failure.code, message, details: toWire(failure.details) }
}

function toRequestError(gateway: GatewayLike, error: unknown, endpoint: string): RequestError {
  if (error instanceof RequestError) return error
  const failure = failureOf(gateway, error)
  const hint = remoteFailureHint(failure.code, failure.details)
  // Gateway failures already name the endpoint; business failures may not.
  const message = failure.message.includes(endpoint) ? failure.message : `${endpoint}: ${failure.message}`
  return new RequestError(
    rpcCodeOfRemote(failure.code),
    `${message}${hint !== undefined ? ` (${hint})` : ''}`,
    { code: failure.code, details: failure.details, endpoint },
  )
}
