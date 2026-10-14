/**
 * Pure wire mappings for the host-control plane (`dsh/remote/*`): the
 * JSON-safe projection of Remote results, byte revival in arguments,
 * endpoint parsing and policy matching, Remote failure -> JSON-RPC error
 * codes, and catalog shaping. No Cordis or SDK runtime imports — every
 * function is unit-tested, like translate.ts.
 */

/** Marker key of an encoded byte array: `{ "$bytes": "<base64>" }`. */
export const BYTES_KEY = '$bytes'

/**
 * Project a native Remote value onto JSON. Remote results are designed for
 * the wire, but a few carry native values the GUI's binary carrier handles
 * out of band: byte arrays (file reads, attachments) become
 * `{ "$bytes": base64 }`, bigints become decimal strings, Maps become
 * objects, Sets become arrays, Dates become ISO strings, and cycles collapse
 * to `"[Circular]"` instead of throwing mid-response.
 */
export function toWire(value: unknown): unknown {
  return project(value, new WeakSet<object>())
}

function project(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Uint8Array) return { [BYTES_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (value instanceof ArrayBuffer) return { [BYTES_KEY]: Buffer.from(value).toString('base64') }
  if (ArrayBuffer.isView(value)) return { [BYTES_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const object = value as object
  if (seen.has(object)) return '[Circular]'
  seen.add(object)
  try {
    if (Array.isArray(object)) return object.map((item) => project(item, seen) ?? null)
    if (object instanceof Set) return [...object].map((item) => project(item, seen) ?? null)
    if (object instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of object) out[String(key)] = project(item, seen)
      return out
    }
    if (object instanceof Error) return { name: object.name, message: object.message }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(object)) {
      const projected = project(item, seen)
      if (projected !== undefined) out[key] = projected
    }
    return out
  } finally {
    seen.delete(object)
  }
}

/**
 * Revive client arguments: every exact `{ "$bytes": base64 }` object becomes
 * a Uint8Array (uploads, terminal input); everything else passes through.
 */
export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === BYTES_KEY && typeof record[BYTES_KEY] === 'string') {
    return new Uint8Array(Buffer.from(record[BYTES_KEY] as string, 'base64'))
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = fromWire(record[key])
  return out
}

/** One canonical Remote endpoint. */
export interface Endpoint {
  readonly namespace: string
  readonly method: string
  /** `<namespace>/<method>` */
  readonly endpoint: string
}

const SEGMENT = /^[A-Za-z_$][\w$-]*$/

/**
 * Read the endpoint of a `dsh/remote/*` request: `{ endpoint: "ns/method" }`
 * or `{ namespace, method }`. Returns an error message instead of throwing so
 * the handler owns the JSON-RPC code.
 */
export function parseEndpoint(params: unknown): Endpoint | string {
  const record = (params !== null && typeof params === 'object') ? params as Record<string, unknown> : {}
  let namespace = record.namespace
  let method = record.method
  if (typeof record.endpoint === 'string') {
    const slash = record.endpoint.indexOf('/')
    if (slash <= 0 || slash === record.endpoint.length - 1) return `invalid endpoint ${JSON.stringify(record.endpoint)} (expected <namespace>/<method>)`
    namespace = record.endpoint.slice(0, slash)
    method = record.endpoint.slice(slash + 1)
  }
  if (typeof namespace !== 'string' || typeof method !== 'string') return 'an endpoint ("<namespace>/<method>") or namespace + method is required'
  if (!SEGMENT.test(namespace) || !SEGMENT.test(method)) return `invalid endpoint ${JSON.stringify(`${namespace}/${method}`)}`
  return { namespace, method, endpoint: `${namespace}/${method}` }
}

/** The `args` object of a `dsh/remote/*` request (absent means none). */
export function argsOf(params: unknown): Record<string, unknown> | string {
  const args = (params !== null && typeof params === 'object') ? (params as { args?: unknown }).args : undefined
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) return 'args must be an object of named wire fields'
  return fromWire(args) as Record<string, unknown>
}

/**
 * Whether an endpoint matches any policy pattern: `*` (everything),
 * `ns/*` (a namespace), or an exact `ns/method`.
 */
export function endpointMatches(endpoint: string, patterns: readonly string[]): boolean {
  const namespace = endpoint.slice(0, endpoint.indexOf('/'))
  return patterns.some((pattern) => pattern === '*' || pattern === endpoint || pattern === `${namespace}/*`)
}

/** JSON-RPC codes the SDK's RequestError carries. */
export const RPC_INVALID_PARAMS = -32602
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INTERNAL = -32603
/** Business failures raised by the Remote method itself (the dsh code rides `data.code`). */
export const RPC_REMOTE_FAILURE = -32000

const NOT_FOUND_CODES = new Set([
  'gateway/invocation-unavailable',
  'gateway/method-unavailable',
  'gateway/service-unavailable',
  'gateway/definition-unavailable',
  'gateway/lookup-unavailable',
  'gateway/context-unavailable',
])
const INVALID_CODES = new Set([
  'gateway/arguments-invalid',
  'gateway/input-invalid',
  'gateway/lookup-not-found',
  'gateway/context-not-found',
])

/** Map a Remote failure code onto the JSON-RPC error code a client branches on. */
export function rpcCodeOfRemote(code: string): number {
  if (NOT_FOUND_CODES.has(code)) return RPC_METHOD_NOT_FOUND
  if (INVALID_CODES.has(code)) return RPC_INVALID_PARAMS
  if (code === 'internal' || code.startsWith('gateway/')) return RPC_INTERNAL
  return RPC_REMOTE_FAILURE
}

/**
 * A correction hint for the failures orchestrators hit most: an `agentId`
 * (or other Session identity) that is persisted but not live.
 */
export function remoteFailureHint(code: string, details: unknown): string | undefined {
  if (code !== 'gateway/lookup-not-found' && code !== 'gateway/context-not-found') return undefined
  const field = (details as { field?: unknown } | undefined)?.field
  if (field === 'agentId') return 'agentId must name a LIVE session: open it first (session/resume, session/new, or dsh/sessions/prompt)'
  return undefined
}

// ── catalog ────────────────────────────────────────────────────────────────

/** The slice of a Typert InvocationDescriptor the catalog reads. */
export interface DescriptorLike {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly implementation?: string
  readonly mode?: 'stream'
  readonly invocation: { readonly kind: string; readonly wire?: string; readonly context?: string }
  readonly parameters: ReadonlyArray<{
    readonly name: string
    readonly wire: string
    readonly source: 'json' | 'lookup'
    readonly lookup?: string
    readonly acceptsUndefined?: true
    readonly codec: CodecLike
  }>
  readonly result: CodecLike
}

export type CodecLike = { readonly mode: 'strict'; readonly create: () => unknown } | { readonly mode: string; readonly create?: () => unknown }

/** One method documentation line keyed by `<service>#<member>`. */
export type MethodDocs = ReadonlyMap<string, string>

export interface CatalogParam {
  /** The wire field to send in `args`. */
  readonly name: string
  readonly optional: boolean
  /** Lookup-resolved identity (e.g. `agent`: the wire value is a live session id). */
  readonly lookup?: string
  readonly schema?: unknown
}

export interface CatalogEntry {
  readonly endpoint: string
  readonly namespace: string
  readonly method: string
  /** Stream methods go through `dsh/remote/stream`; unary ones through `dsh/remote/invoke`. */
  readonly stream: boolean
  /** Whether the owning Cordis service is mounted at catalog time. */
  readonly available?: boolean
  readonly params: CatalogParam[]
  readonly result?: unknown
  readonly summary?: string
  readonly package?: string
}

/** Shape one live descriptor into its catalog entry. */
export function catalogEntryOf(descriptor: DescriptorLike, docs: MethodDocs, withSchemas: boolean): CatalogEntry {
  const params: CatalogParam[] = []
  // A context-invoked method selects its receiver from a wire identity that
  // is not a business parameter; it still has to be sent.
  if (descriptor.invocation.kind === 'context' && typeof descriptor.invocation.wire === 'string') {
    params.push({
      name: descriptor.invocation.wire,
      optional: false,
      lookup: descriptor.invocation.context,
      ...withSchemas ? { schema: { type: 'string' } } : {},
    })
  }
  for (const parameter of descriptor.parameters) {
    params.push({
      name: parameter.wire,
      optional: parameter.acceptsUndefined === true,
      ...parameter.source === 'lookup' && parameter.lookup !== undefined ? { lookup: parameter.lookup } : {},
      ...withSchemas ? { schema: jsonSchemaOf(parameter.codec, 'input') } : {},
    })
  }
  const member = descriptor.implementation ?? descriptor.method
  const summary = docs.get(`${descriptor.service}#${member}`)
  const hash = descriptor.id.indexOf('#')
  return {
    endpoint: `${descriptor.namespace}/${descriptor.method}`,
    namespace: descriptor.namespace,
    method: descriptor.method,
    stream: descriptor.mode === 'stream',
    params,
    ...withSchemas ? { result: jsonSchemaOf(descriptor.result, 'output') } : {},
    ...summary !== undefined ? { summary } : {},
    ...hash > 0 && !descriptor.id.startsWith('src:') ? { package: descriptor.id.slice(0, hash) } : {},
  }
}

/**
 * JSON Schema of a strict codec, via the zod 4 schema's own `toJSONSchema`
 * (duck-typed: the schema lives in the host's zod realm). SRC-marked
 * methods carry no schema.
 */
export function jsonSchemaOf(codec: CodecLike, io: 'input' | 'output'): unknown {
  if (codec.mode !== 'strict' || codec.create === undefined) return undefined
  try {
    const schema = codec.create() as { toJSONSchema?: (params?: unknown) => unknown }
    if (typeof schema.toJSONSchema !== 'function') return undefined
    return compactSchema(schema.toJSONSchema({ unrepresentable: 'any', io }))
  } catch {
    return undefined
  }
}

/**
 * Drop JSON Schema noise that costs an orchestrator's context without
 * informing a call: `$schema`, `readOnly` (every Remote field is readonly),
 * and branded-string intersections (`allOf: [{type:'string'}, {}]`).
 */
export function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const record = schema as Record<string, unknown>
  const allOf = record.allOf
  if (Array.isArray(allOf) && allOf.length === 2 && isEmptyObject(allOf[1]) && Object.keys(record).every((key) => key === 'allOf' || key === 'readOnly' || key === '$schema')) {
    return compactSchema(allOf[0])
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '$schema' || key === 'readOnly') continue
    out[key] = compactSchema(value)
  }
  return out
}

function isEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/** The slice of a Typert package model the catalog docs read. */
export interface PackageModelLike {
  readonly model: {
    readonly services: ReadonlyArray<{
      readonly key: string
      readonly summary?: string
      readonly members: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly summary?: string }>
    }>
  }
}

/** Index method summaries by `<serviceKey>#<member>`. */
export function methodDocsOf(packages: readonly PackageModelLike[]): Map<string, string> {
  const docs = new Map<string, string>()
  for (const pkg of packages) {
    for (const service of pkg.model.services) {
      for (const member of service.members) {
        if (member.kind !== 'method' || member.summary === undefined || member.summary.length === 0) continue
        docs.set(`${service.key}#${member.name}`, member.summary)
      }
    }
  }
  return docs
}
