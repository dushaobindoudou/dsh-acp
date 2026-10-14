import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachQuestionBridge } from '../../lib/question-bridge.js'
import { recordCapabilities } from '../../lib/connections.js'

const questions = [{ id: 'color', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] }]

function bridge(policy, client) {
  let listener
  const ctx = { on(name, fn, options) {
    assert.equal(name, 'user-questions/request')
    assert.equal(options.prepend, true)
    listener = fn
    return () => undefined
  } }
  attachQuestionBridge(ctx, { sessionId: 's', permissionPolicy: policy, client }, () => undefined)
  return (request = {}, next = async () => ({ fallback: true })) => listener({ questions, agent: { id: 's' }, ...request }, next)
}

test('question policies handle detached sessions and stay scoped to the agent', async () => {
  assert.deepEqual(await bridge('auto')(), { answers: [{ id: 'color', selected: ['red'] }] })
  assert.deepEqual(await bridge('deny')(), { answers: [{ id: 'color', selected: [] }] })
  assert.deepEqual(await bridge('ask')(), { fallback: true })
  assert.deepEqual(await bridge('auto')({ agent: { id: 'other' } }), { fallback: true })
})

test('form-capable clients receive a scoped elicitation and decline skips questions', async () => {
  const sent = []
  let action = 'accept'
  const key = {}
  const client = { connectionContext: key, async request(method, params) {
    sent.push({ method, params })
    return { action, content: { color: 'blue' } }
  } }
  recordCapabilities({ connectionContext: key }, { elicitation: { form: {} } })
  const ask = bridge('ask', client)
  assert.deepEqual(await ask({ wait: { callId: 'call-1' } }), { answers: [{ id: 'color', selected: ['blue'] }] })
  assert.equal(sent[0].method, 'elicitation/create')
  assert.equal(sent[0].params.sessionId, 's')
  assert.equal(sent[0].params.toolCallId, 'call-1')
  action = 'decline'
  assert.deepEqual(await ask(), { answers: [{ id: 'color', selected: [] }] })
  action = 'cancel'
  await assert.rejects(ask(), /dismissed/)
})

test('clients without forms use permission buttons and rich questions fall through', async () => {
  let calls = 0
  const ask = bridge('ask', { async request(method) {
    calls += 1
    assert.equal(method, 'session/request_permission')
    return { outcome: { outcome: 'selected', optionId: 'question-1' } }
  } })
  assert.deepEqual(await ask(), { answers: [{ id: 'color', selected: ['blue'] }] })
  assert.deepEqual(await ask({ questions: [{ id: 'text', question: 'Name?' }] }), { fallback: true })
  assert.equal(calls, 1)
})

test('question cancellation releases a pending client request', async () => {
  const controller = new AbortController()
  const ask = bridge('ask', { request: () => new Promise(() => {}) })
  const result = ask({ signal: controller.signal })
  controller.abort(new Error('turn cancelled'))
  await assert.rejects(result, /turn cancelled/)
})

test('already-cancelled questions do not open a client dialog', async () => {
  let calls = 0
  const ask = bridge('ask', { async request() {
    calls += 1
    return { outcome: { outcome: 'cancelled' } }
  } })
  await assert.rejects(ask({ signal: AbortSignal.abort(new Error('turn cancelled')) }), /turn cancelled/)
  assert.equal(calls, 0)
})
