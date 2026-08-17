/**
 * End-to-end M1 test: boots the REAL `dsh --profile acp` process with a
 * throwaway $DSH_HOME and the mock-LLM overlay, drives it as an ACP client
 * over NDJSON stdio, and asserts the full M1 conversation shape:
 *
 *   initialize -> session/new -> prompt (streaming text) -> prompt (tool
 *   call lifecycle) -> session/close -> clean exit on stdin EOF.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshBin = process.env.DSH_BIN ?? 'dsh'

const PASS = (message) => process.stdout.write(`  ok - ${message}\n`)
const FAIL = (message) => {
  process.stderr.write(`  not ok - ${message}\n`)
  dumpLogs()
  process.exit(1)
}
let logPaths = []
function dumpLogs() {
  for (const path of logPaths) {
    if (!existsSync(path)) continue
    process.stderr.write(`--- ${path} ---\n${readFileSync(path, 'utf8').slice(-4000)}\n`)
  }
}

// ── 1+2. install via the OFFICIAL command into a throwaway home ───────────
// `dsh plugin --profile acp add <path>` initializes the profile template,
// installs the bundle with pnpm, and reconciles dsh.profile.bundles itself.
const tmp = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-'))
const home = join(tmp, 'home')
const project = join(tmp, 'project')
mkdirSync(project, { recursive: true })

const install = spawnSync(dshBin, ['plugin', '--profile', 'acp', 'add', repoRoot], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
  timeout: 240_000,
})
if (install.status !== 0) {
  process.stderr.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  FAIL('dsh plugin --profile acp add failed')
}
const bundles = JSON.parse(readFileSync(join(home, 'profiles', 'acp', 'package.json'), 'utf8'))
  .dsh?.profile?.bundles ?? []
if (!bundles.includes('dsh-acp')) {
  FAIL(`dsh.profile.bundles did not pick up dsh-acp: ${JSON.stringify(bundles)}`)
}
PASS('installed dsh-acp via `dsh plugin add` (bundles list reconciled)')

// ── 3. boot dsh --profile acp with the mock overlay ───────────────────────
const overlay = join(repoRoot, 'test', 'e2e', 'test-acp.overlay.yml')
const stderrPath = join(tmp, 'dsh-stderr.log')
const stderrFd = (await import('node:fs')).openSync(stderrPath, 'a')
logPaths = [stderrPath]

const child = spawn(dshBin, ['--profile', 'acp', '--patch', overlay], {
  cwd: project,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', stderrFd],
})

// ── 4. tiny ACP client over the child's stdio ─────────────────────────────
let nextId = 1
const pending = new Map()
const notifications = []

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      FAIL(`non-JSON line on stdout: ${line.slice(0, 200)}`)
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`))
      else resolve(message.result)
    } else if (message.method !== undefined) {
      notifications.push(message)
    }
  }
})

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const notify = (method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}
const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms)),
  ])

const updatesFor = (sessionId) =>
  notifications.filter((n) => n.method === 'session/update' && n.params.sessionId === sessionId).map((n) => n.params.update)

// ── 5. the M1 conversation ────────────────────────────────────────────────
try {
  const init = await withTimeout(send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 60_000, 'initialize')
  assert.equal(init.protocolVersion, 1)
  assert.equal(init.agentInfo.name, 'dsh')
  PASS('initialize handshake')

  const session = await withTimeout(send('session/new', { cwd: project, mcpServers: [] }), 120_000, 'session/new')
  const sessionId = session.sessionId
  assert.match(sessionId, /^acp-/)
  PASS(`session/new -> ${sessionId}`)

  // 5a. plain streaming prompt
  const first = await withTimeout(send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Hello' }] }), 120_000, 'prompt #1')
  assert.equal(first.stopReason, 'end_turn')
  const firstUpdates = updatesFor(sessionId)
  const thoughts = firstUpdates.filter((u) => u.sessionUpdate === 'agent_thought_chunk')
  const messages = firstUpdates.filter((u) => u.sessionUpdate === 'agent_message_chunk')
  assert.equal(thoughts.length, 1, 'one reasoning chunk')
  assert.ok(messages.length >= 2, `streamed ${messages.length} message chunks`)
  assert.equal(messages[0].messageId, messages[1].messageId, 'stable messageId across chunks')
  assert.match(messages.map((m) => m.content.text).join(''), /Hello from dsh-acp mock/)
  PASS('prompt #1 streamed thought + message chunks')

  // 5b. tool-call lifecycle prompt
  const second = await withTimeout(send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'CALL_TOOL now' }] }), 120_000, 'prompt #2')
  assert.equal(second.stopReason, 'end_turn')
  const secondUpdates = updatesFor(sessionId).filter((u) => !firstUpdates.includes(u))
  const toolCall = secondUpdates.find((u) => u.sessionUpdate === 'tool_call')
  assert.ok(toolCall !== undefined, 'tool_call update emitted')
  assert.equal(toolCall.toolCallId, 'mock-call-1')
  assert.equal(toolCall.kind, 'execute')
  assert.equal(toolCall.status, 'pending')
  const inProgress = secondUpdates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress')
  const completed = secondUpdates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')
  assert.ok(inProgress !== undefined, 'in_progress update emitted')
  assert.ok(completed !== undefined, 'completed update emitted')
  const completedText = (completed.content ?? []).map((c) => c.content?.text ?? '').join('')
  assert.match(completedText, /acp-e2e-ok/, 'bash tool output surfaced in the tool call content')
  const afterTool = secondUpdates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')
  assert.match(afterTool, /tool said:/, 'model answered with the tool result')
  PASS('prompt #2 exercised full tool_call lifecycle (pending -> in_progress -> completed)')

  // 5c. close
  const closed = await withTimeout(send('session/close', { sessionId }), 60_000, 'session/close')
  assert.deepEqual(closed, {})
  PASS('session/close')

  // 5d. clean exit on EOF
  child.stdin.end()
  const exitCode = await withTimeout(
    new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    60_000,
    'process exit after EOF',
  )
  assert.equal(exitCode, 0, 'clean exit 0 on stdin EOF')
  PASS('stdin EOF -> clean exit')

  process.stdout.write('E2E OK\n')
  process.exit(0)
} catch (error) {
  FAIL(String(error instanceof Error ? error.stack ?? error.message : error))
}
