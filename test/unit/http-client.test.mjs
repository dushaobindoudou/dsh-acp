import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openServer } from '../../lib/cli/connect.js'
import { httpClientStream, acpEndpointOf } from '../../lib/cli/http-client.js'

test('HTTP authentication refusal rejects the CLI handshake promptly', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unauthorized', { status: 401 }))
  let timer
  try {
    await assert.rejects(Promise.race([
      openServer({ url: 'http://acp.test', cwd: process.cwd() }, (app) => app),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('handshake hung')), 1000) }),
    ]), /refused the token/)
  } finally {
    clearTimeout(timer)
  }
})

test('HTTP network failure is reported to the connection owner', async (t) => {
  const failure = new Error('network unavailable')
  t.mock.method(globalThis, 'fetch', async () => { throw failure })
  const errors = []
  const stream = httpClientStream({ url: 'http://acp.test', onError: (error) => errors.push(error) })
  const reader = stream.readable.getReader()
  const read = reader.read().catch((error) => error)
  const writer = stream.writable.getWriter()
  try {
    await assert.rejects(writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), /network unavailable/)
    assert.deepEqual(errors, [failure])
    assert.equal(await read, failure)
  } finally {
    await stream.close()
    reader.releaseLock()
    writer.releaseLock()
  }
})

test('base URLs and ACP endpoint URLs normalize to the same endpoint', () => {
  assert.equal(acpEndpointOf('http://localhost:7800/'), 'http://localhost:7800/acp')
  assert.equal(acpEndpointOf('http://localhost:7800/acp/'), 'http://localhost:7800/acp')
})

test('HTTP close aborts the stream before sending bounded authenticated cleanup', async (t) => {
  const requests = []
  let streamSignal
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init })
    assert.equal(init.headers.authorization, 'Bearer secret')
    if (init.method === 'POST') return Response.json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'acp-connection-id': 'connection-1' } })
    if (init.method === 'DELETE') {
      assert.equal(streamSignal.aborted, true)
      assert.ok(init.signal instanceof AbortSignal, 'DELETE has its own deadline')
      assert.equal(init.signal.aborted, false)
      return new Response(null, { status: 204 })
    }
    streamSignal = init.signal
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true })
    } }))
  })
  const errors = []
  const stream = httpClientStream({ url: 'http://acp.test', token: 'secret', onError: (error) => errors.push(error) })
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  await writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal((await reader.read()).value.id, 1)
  await stream.close()
  await stream.close()
  assert.equal((await reader.read()).done, true)
  assert.equal(requests.filter(({ init }) => init.method === 'DELETE').length, 1)
  assert.equal(requests.at(-1).init.headers['acp-connection-id'], 'connection-1')
  assert.deepEqual(errors, [])
  writer.releaseLock()
  reader.releaseLock()
})
