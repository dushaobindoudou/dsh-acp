import assert from 'node:assert/strict'
import test from 'node:test'
import { translateSessionEventAll } from '../../lib/event-bridge.js'

test('tool results from DSH 0.1 and 0.2 carry the same ACP update', () => {
  const old = translateSessionEventAll({
    type: 'tool/result',
    data: { message: {
      role: 'user', source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false,
        content: [{ type: 'text', text: 'done' }] }],
    } },
  })
  const current = translateSessionEventAll({
    type: 'tool/result',
    data: { message: { role: 'tool', toolCallId: 'call-1', isError: false,
      content: [{ type: 'text', text: 'done' }] } },
  })
  assert.deepEqual(old, current)
  assert.deepEqual(old, [{
    sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
  }])
})
