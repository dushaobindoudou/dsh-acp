import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatCatalog, parseJsonArg, positiveNumberArg } from '../../lib/cli/control-core.js'

test('control commands accept JSON objects and explain invalid arguments', () => {
  assert.deepEqual(parseJsonArg(undefined, 'call arguments'), {})
  assert.deepEqual(parseJsonArg('  ', 'call arguments'), {})
  assert.deepEqual(parseJsonArg('{"request":{"path":"/tmp/project"}}', 'call arguments'), { request: { path: '/tmp/project' } })
  for (const raw of ['null', '[]', 'true', '1', '"string"', '{']) {
    assert.throws(() => parseJsonArg(raw, 'call arguments'), /call arguments must be a JSON object/)
  }
})

test('catalog text identifies streaming, optional, and lookup arguments', () => {
  const output = formatCatalog([
    { endpoint: 'session/follow', stream: true, params: [{ name: 'agentId', optional: false, lookup: 'agent' }, { name: 'cursor', optional: true }], summary: 'Follow the session.\nMore details.' },
    { endpoint: 'settings/describe', stream: false, params: [] },
  ])
  assert.match(output, /session\/follow\(agentId<agent>, cursor\?\) \[stream\]/)
  assert.match(output, /Follow the session\./)
  assert.doesNotMatch(output, /More details/)
  assert.match(output, /settings\/describe\(\)/)
  assert.equal(formatCatalog([]), '')
})

test('timeouts and item limits reject invalid values before opening a connection', () => {
  assert.equal(positiveNumberArg('0.5', '--timeout'), 0.5)
  assert.equal(positiveNumberArg('2', '--limit', true), 2)
  for (const text of ['NaN', 'Infinity', '-1', '0', '', 'oops']) {
    assert.throws(() => positiveNumberArg(text, '--timeout'), /--timeout expects a positive finite number/)
  }
  assert.throws(() => positiveNumberArg('1.5', '--limit', true), /--limit expects a positive integer/)
})

test('CLI reports invalid bounds with exit 1 before spawning DSH', () => {
  const bin = fileURLToPath(new URL('../../bin/dsh-acp.mjs', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'dsh-acp-invalid-'))
  try {
    for (const args of [
      ['stream', 'workspace/follow', '--limit', '0'],
      ['stream', 'workspace/follow', '--timeout', 'NaN'],
      ['run', 'hello', '--timeout', 'Infinity'],
    ]) {
      const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, DSH_HOME: home, DSH_BIN: '/missing-dsh-for-argument-validation' },
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /expects a positive/)
      assert.equal(result.stdout, '')
      assert.doesNotMatch(result.stderr, /bootstrapping|ENOENT/)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
