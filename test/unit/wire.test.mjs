/**
 * The host-control plane's pure layer: JSON projection of Remote values,
 * byte revival, endpoint parsing and deny policy, Remote failure codes, and
 * catalog shaping from Typert descriptors.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  argsOf,
  catalogEntryOf,
  compactSchema,
  endpointMatches,
  fromWire,
  methodDocsOf,
  parseEndpoint,
  remoteFailureHint,
  rpcCodeOfRemote,
  toWire,
} from '../../lib/wire.js'

test('toWire projects native values onto JSON', () => {
  const cyclic = { name: 'a' }
  cyclic.self = cyclic
  assert.deepEqual(toWire({
    bytes: new Uint8Array([1, 2, 3]),
    big: 10n,
    when: new Date('2026-01-02T03:04:05.000Z'),
    map: new Map([['k', 1]]),
    set: new Set(['x']),
    gone: undefined,
    fn: () => 1,
    list: [undefined, 1],
    cyclic,
  }), {
    bytes: { $bytes: 'AQID' },
    big: '10',
    when: '2026-01-02T03:04:05.000Z',
    map: { k: 1 },
    set: ['x'],
    list: [null, 1],
    cyclic: { name: 'a', self: '[Circular]' },
  })
  // A repeated (non-cyclic) reference is not a cycle.
  const shared = { v: 1 }
  assert.deepEqual(toWire({ a: shared, b: shared }), { a: { v: 1 }, b: { v: 1 } })
})

test('fromWire revives exact $bytes objects only', () => {
  const revived = fromWire({ data: { $bytes: 'AQID' }, keep: { $bytes: 'x', other: 1 }, list: [{ $bytes: 'AA==' }] })
  assert.ok(revived.data instanceof Uint8Array)
  assert.deepEqual([...revived.data], [1, 2, 3])
  assert.deepEqual(revived.keep, { $bytes: 'x', other: 1 })
  assert.deepEqual([...revived.list[0]], [0])
})

test('parseEndpoint accepts endpoint or namespace+method and rejects junk', () => {
  assert.deepEqual(parseEndpoint({ endpoint: 'workspace/create' }), { namespace: 'workspace', method: 'create', endpoint: 'workspace/create' })
  assert.deepEqual(parseEndpoint({ namespace: 'session', method: 'list' }), { namespace: 'session', method: 'list', endpoint: 'session/list' })
  assert.equal(typeof parseEndpoint({ endpoint: 'nope' }), 'string')
  assert.equal(typeof parseEndpoint({ endpoint: '/x' }), 'string')
  assert.equal(typeof parseEndpoint({ endpoint: 'a/b/c' }), 'string')
  assert.equal(typeof parseEndpoint({}), 'string')
})

test('argsOf defaults to {} and refuses non-objects', () => {
  assert.deepEqual(argsOf({}), {})
  assert.deepEqual(argsOf({ args: null }), {})
  assert.deepEqual(argsOf({ args: { a: 1 } }), { a: 1 })
  assert.equal(typeof argsOf({ args: [1] }), 'string')
  assert.equal(typeof argsOf({ args: 'x' }), 'string')
})

test('endpointMatches supports *, ns/*, and exact patterns', () => {
  assert.equal(endpointMatches('credentials/set', ['credentials/*']), true)
  assert.equal(endpointMatches('credentials/set', ['credentials/unset']), false)
  assert.equal(endpointMatches('credentials/set', ['credentials/set']), true)
  assert.equal(endpointMatches('a/b', ['*']), true)
  assert.equal(endpointMatches('a/b', []), false)
})

test('rpcCodeOfRemote maps gateway and business failures', () => {
  assert.equal(rpcCodeOfRemote('gateway/invocation-unavailable'), -32601)
  assert.equal(rpcCodeOfRemote('gateway/arguments-invalid'), -32602)
  assert.equal(rpcCodeOfRemote('gateway/lookup-not-found'), -32602)
  assert.equal(rpcCodeOfRemote('gateway/protocol'), -32603)
  assert.equal(rpcCodeOfRemote('internal'), -32603)
  assert.equal(rpcCodeOfRemote('workspace/not-found'), -32000)
  assert.match(remoteFailureHint('gateway/lookup-not-found', { field: 'agentId' }), /LIVE session/)
  assert.equal(remoteFailureHint('gateway/lookup-not-found', { field: 'other' }), undefined)
})

test('compactSchema drops noise and collapses branded strings', () => {
  assert.deepEqual(compactSchema({
    $schema: 'x',
    type: 'object',
    properties: { id: { readOnly: true, allOf: [{ type: 'string' }, {}] }, n: { type: 'number', readOnly: true } },
  }), { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' } } })
  assert.deepEqual(compactSchema({ $schema: 'x', allOf: [{ type: 'string' }, {}] }), { type: 'string' })
})

test('catalogEntryOf shapes params, lookups, stream flag, docs, and schemas', () => {
  const strict = (schema) => ({ mode: 'strict', create: () => ({ toJSONSchema: () => schema }) })
  const descriptor = {
    id: '@deepseek-ai/dsh-goal#goals/get',
    service: 'goals',
    namespace: 'goals',
    method: 'get',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: strict({ type: 'string' }) },
      { name: 'opt', wire: 'opt', source: 'json', acceptsUndefined: true, codec: { mode: 'src-json' } },
    ],
    result: strict({ $schema: 'x', type: 'object' }),
  }
  const docs = methodDocsOf([{ model: { services: [{ key: 'goals', members: [{ name: 'get', kind: 'method', summary: 'Read the goal.' }, { name: 'x', kind: 'property', summary: 'no' }] }] } }])
  assert.deepEqual(catalogEntryOf(descriptor, docs, true), {
    endpoint: 'goals/get',
    namespace: 'goals',
    method: 'get',
    stream: false,
    params: [
      { name: 'agentId', optional: false, lookup: 'agent', schema: { type: 'string' } },
      { name: 'opt', optional: true, schema: undefined },
    ],
    result: { type: 'object' },
    summary: 'Read the goal.',
    package: '@deepseek-ai/dsh-goal',
  })
  const lean = catalogEntryOf({ ...descriptor, id: 'src:goals#goals/get', mode: 'stream' }, new Map(), false)
  assert.equal(lean.stream, true)
  assert.equal(lean.package, undefined)
  assert.equal('result' in lean, false)
  assert.equal('schema' in lean.params[0], false)
})

test('catalogEntryOf lists a context-invoked receiver identity as a param', () => {
  const entry = catalogEntryOf({
    id: 'p#ns/m', service: 's', namespace: 'ns', method: 'm',
    invocation: { kind: 'context', context: 'agent', wire: 'agentId' },
    parameters: [], result: { mode: 'src-json' },
  }, new Map(), false)
  assert.deepEqual(entry.params, [{ name: 'agentId', optional: false, lookup: 'agent' }])
})
