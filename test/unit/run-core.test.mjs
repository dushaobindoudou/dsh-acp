/**
 * The `run` CLI's pure mapping layer: prompt folding with attachments,
 * permission-policy answers, update collection (final text + tool calls),
 * the exit-code contract, and the --json result shape.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_TIMEOUT,
  EXIT_CANCELLED,
  EXIT_PERMISSION_DENIED,
  buildPromptBlocks,
  exitCodeFor,
  finalTextOf,
  isDenyingOutcome,
  jsonResultOf,
  parseModelSpec,
  permissionAnswer,
  toolCallsOf,
} from '../../lib/cli/run-core.js'

test('buildPromptBlocks keeps the task first and inlines text attachments', () => {
  const blocks = buildPromptBlocks('fix the bug', [
    { name: 'notes.txt', bytes: new TextEncoder().encode('line one') },
  ])
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: 'fix the bug' })
  assert.equal(blocks[1].type, 'text')
  assert.match(blocks[1].text, /--- attached file: notes\.txt ---/)
  assert.match(blocks[1].text, /line one/)
})

test('buildPromptBlocks maps image extensions onto image blocks with base64', () => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const blocks = buildPromptBlocks('what is this', [{ name: 'shot.png', bytes }])
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[1], { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' })
  const jpeg = buildPromptBlocks('x', [{ name: 'a.JPG', bytes }])
  assert.equal(jpeg[1].mimeType, 'image/jpeg')
})

test('buildPromptBlocks treats unknown extensions as text', () => {
  const blocks = buildPromptBlocks('x', [{ name: 'data.csv', bytes: new TextEncoder().encode('a,b') }])
  assert.equal(blocks[1].type, 'text')
})

test('permissionAnswer ranks one-shot outcomes under fixed policies', () => {
  const options = [
    { optionId: 'reject-always', kind: 'reject_always' },
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'allow-always', kind: 'allow_always' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ]
  assert.deepEqual(permissionAnswer('auto', options), { outcome: 'selected', optionId: 'allow-once' })
  assert.deepEqual(permissionAnswer('deny', options), { outcome: 'selected', optionId: 'reject-once' })
  assert.equal(permissionAnswer('ask', options), undefined)
  // Only allow options: deny has nothing to select (the caller decides).
  assert.equal(permissionAnswer('deny', [{ optionId: 'allow-once', kind: 'allow_once' }]), undefined)
})

test('isDenyingOutcome tracks the chosen option kind', () => {
  const options = [{ optionId: 'r', kind: 'reject_once' }, { optionId: 'a', kind: 'allow_once' }]
  assert.equal(isDenyingOutcome({ outcome: 'selected', optionId: 'r' }, options), true)
  assert.equal(isDenyingOutcome({ outcome: 'selected', optionId: 'a' }, options), false)
  assert.equal(isDenyingOutcome({ outcome: 'cancelled' }, options), false)
})

test('finalTextOf folds agent message chunks in order and skips thoughts', () => {
  const text = finalTextOf([
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
    { sessionUpdate: 'tool_call', title: 'bash' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
  ])
  assert.equal(text, 'Hello world')
})

test('toolCallsOf merges title (first) and status (last) per tool call', () => {
  const calls = toolCallsOf([
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash echo' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
    { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'read file' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' },
  ])
  assert.deepEqual(calls, [
    { title: 'bash echo', status: 'completed' },
    { title: 'read file', status: 'failed' },
  ])
})

test('exitCodeFor enforces the documented precedence', () => {
  assert.equal(exitCodeFor({ timedOut: false, stopReason: 'end_turn', permissionDenied: false }), EXIT_OK)
  assert.equal(exitCodeFor({ error: 'boom', timedOut: true, stopReason: 'cancelled', permissionDenied: true }), EXIT_ERROR)
  assert.equal(exitCodeFor({ timedOut: true, stopReason: 'cancelled', permissionDenied: true }), EXIT_TIMEOUT)
  assert.equal(exitCodeFor({ timedOut: false, stopReason: 'cancelled', permissionDenied: true }), EXIT_CANCELLED)
  assert.equal(exitCodeFor({ timedOut: false, stopReason: 'end_turn', permissionDenied: true }), EXIT_PERMISSION_DENIED)
  assert.equal(exitCodeFor({ timedOut: false, stopReason: 'max_tokens', permissionDenied: false }), EXIT_OK)
  assert.equal(EXIT_ERROR, 1)
  assert.equal(EXIT_TIMEOUT, 2)
  assert.equal(EXIT_CANCELLED, 3)
  assert.equal(EXIT_PERMISSION_DENIED, 4)
})

test('jsonResultOf shapes the machine-readable payload', () => {
  const updates = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash echo' },
  ]
  const result = jsonResultOf({
    sessionId: 'acp-1', updates, usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
    error: undefined, timedOut: false, stopReason: 'end_turn', permissionDenied: false,
  })
  assert.deepEqual(result, {
    sessionId: 'acp-1',
    stopReason: 'end_turn',
    text: 'done',
    toolCalls: [{ title: 'bash echo', status: undefined }],
    usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
  })
  const failed = jsonResultOf({
    sessionId: 's', updates: [], error: 'boom', timedOut: false, stopReason: undefined, permissionDenied: false,
  })
  assert.equal(failed.error, 'boom')
  assert.equal('usage' in failed, false)
})

test('parseModelSpec splits on the first slash and rejects malformed specs', () => {
  assert.deepEqual(parseModelSpec('liepin/glm-5-3'), { provider: 'liepin', model: 'glm-5-3' })
  assert.deepEqual(parseModelSpec('gateway/org/big'), { provider: 'gateway', model: 'org/big' })
  assert.throws(() => parseModelSpec('noslash'), /<provider>\/<model>/)
  assert.throws(() => parseModelSpec('/model'), /<provider>\/<model>/)
  assert.throws(() => parseModelSpec('p/'), /<provider>\/<model>/)
})
