import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accumulateUsage,
  acpUsageOf,
  chunkKind,
  contextUsageUpdateOf,
  contextUsedOf,
  emptyUsageTotals,
  locationsOf,
  messageChunkId,
  promptToContent,
  stopReasonOf,
  toolContentOf,
  toolKindOf,
  toolTitleOf,
} from '../../lib/translate.js'

test('stopReasonOf maps every DSH turn-end reason', () => {
  assert.equal(stopReasonOf({ kind: 'completed' }), 'end_turn')
  assert.equal(stopReasonOf({ kind: 'aborted', reason: { kind: 'user' } }), 'cancelled')
  assert.equal(stopReasonOf({ kind: 'max-tokens' }), 'max_tokens')
  assert.equal(stopReasonOf({ kind: 'error', error: { message: 'boom', code: 'X' } }), 'end_turn')
  assert.equal(stopReasonOf({ kind: 'blocked' }), 'cancelled')
  assert.equal(stopReasonOf({ kind: 'interrupted' }), 'cancelled')
  assert.equal(stopReasonOf(undefined), 'end_turn')
})

test('toolKindOf maps dsh tools onto ACP kinds', () => {
  assert.equal(toolKindOf('bash'), 'execute')
  assert.equal(toolKindOf('read'), 'read')
  assert.equal(toolKindOf('str_replace_editor'), 'edit')
  assert.equal(toolKindOf('glob'), 'search')
  assert.equal(toolKindOf('web_search'), 'fetch')
  assert.equal(toolKindOf('subagent'), 'think')
  assert.equal(toolKindOf('something_new'), 'other')
})

test('toolTitleOf prefers the interesting argument', () => {
  assert.equal(toolTitleOf('bash', { command: 'echo hi\necho bye' }), 'echo hi')
  assert.equal(toolTitleOf('read', { file_path: '/tmp/a.ts' }), '/tmp/a.ts')
  assert.equal(toolTitleOf('edit', { file_path: '/tmp/a.ts' }), 'edit /tmp/a.ts')
  assert.equal(toolTitleOf('bash', {}), 'bash')
  assert.equal(toolTitleOf('unknown', null), 'unknown')
})

test('locationsOf extracts the first path-ish argument', () => {
  assert.deepEqual(locationsOf({ file_path: '/tmp/a.ts', line: 3 }), [{ path: '/tmp/a.ts' }])
  assert.deepEqual(locationsOf({ path: '/tmp/b.ts' }), [{ path: '/tmp/b.ts' }])
  assert.deepEqual(locationsOf({ pattern: 'x' }), [])
})

test('toolContentOf converts text blocks and skips reasoning', () => {
  assert.deepEqual(
    toolContentOf([
      { type: 'text', text: 'ok' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: '' },
    ]),
    [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  )
})

test('promptToContent flattens ACP blocks to DSH text', () => {
  const blocks = promptToContent([
    { type: 'text', text: 'hello' },
    { type: 'resource_link', uri: 'file:///tmp/x.ts', name: 'x.ts' },
  ])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /hello/)
  assert.match(blocks[0].text, /x\.ts\]\(file:\/\/\/tmp\/x\.ts\)/)
})

test('chunkKind separates message, thought, and noise', () => {
  assert.equal(chunkKind({ type: 'text-delta', index: 0, text: 'a' }), 'message')
  assert.equal(chunkKind({ type: 'reasoning-delta', index: 0, text: 'b' }), 'thought')
  assert.equal(chunkKind({ type: 'text-delta', index: 0, text: '' }), undefined)
  assert.equal(chunkKind({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }), undefined)
})

test('messageChunkId is stable per turn/step', () => {
  assert.equal(messageChunkId(1, 2), 'm-1-2')
})

test('usage mapping: accumulate, context footprint, ACP shape', () => {
  const totals = emptyUsageTotals()
  accumulateUsage(totals, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 3 })
  accumulateUsage(totals, { inputTokens: 7, outputTokens: 2, totalTokens: 20, cacheWriteTokens: 1 })
  // Call footprint: adapter total wins, otherwise disjoint counters sum.
  assert.equal(contextUsedOf({ inputTokens: 1, outputTokens: 2, totalTokens: 9 }), 9)
  assert.equal(contextUsedOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), 10)
  // First call had no adapter total: 10 + 4 + 0 + 5 = 19; second reported 20.
  assert.deepEqual(acpUsageOf(totals), {
    totalTokens: 39, inputTokens: 17, outputTokens: 7,
    thoughtTokens: 3, cachedReadTokens: 4, cachedWriteTokens: 1,
  })
  assert.equal(acpUsageOf(undefined), undefined)
  assert.equal(acpUsageOf(emptyUsageTotals()), undefined, 'no reported usage -> no usage field')
})

test('contextUsageUpdateOf needs a positive context window', () => {
  assert.deepEqual(contextUsageUpdateOf({ inputTokens: 12, outputTokens: 3, totalTokens: 15 }, 32768), { used: 15, size: 32768 })
  assert.equal(contextUsageUpdateOf({ inputTokens: 12, outputTokens: 3 }, undefined), undefined)
  assert.equal(contextUsageUpdateOf({ inputTokens: 12, outputTokens: 3 }, 0), undefined)
})
