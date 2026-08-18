/**
 * End-to-end serve-mode test: boots `dsh --profile acp serve` with the mock
 * overlay, drives the whole M1 conversation over HTTP+SSE (the transport
 * shape of the ACP streamable-HTTP RFD draft), including the tool-call
 * lifecycle and connection teardown.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshBin = process.env.DSH_BIN ?? 'dsh'

const PASS = (message) => process.stdout.write(`  ok - ${message}\n`)
const FAIL = (message) => {
  process.stderr.write(`  not ok - ${message}\n`)
  for (const path of ['/tmp/dsh-acp-serve-stderr.log']) {
    if (existsSync(path)) process.stderr.write(`--- ${path} ---\n${readFileSync(path, 'utf8').slice(-4000)}\n`)
  }
  process.exit(1)
}

// ── profile install (official command, throwaway home) ─────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'dsh-acp-serve-'))
const home = join(tmp, 'home')
const project = join(tmp, 'project')
mkdirSync(project, { recursive: true })

const install = spawnSync(dshBin, ['plugin', '--profile', 'acp', 'add', process.env.DSH_ACP_PKG ?? repoRoot], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
  timeout: 240_000,
})
if (install.status !== 0) {
  process.stderr.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  FAIL('dsh plugin add failed')
}
PASS('installed dsh-acp-server via `dsh plugin add`')

// ── boot serve mode ────────────────────────────────────────────────────────
const overlay = join(repoRoot, 'test', 'e2e', 'test-acp.overlay.yml')
const stderrLog = '/tmp/dsh-acp-serve-stderr.log'
const { openSync } = await import('node:fs')
const stderrFd = openSync(stderrLog, 'w')
const child = spawn(dshBin, ['--profile', 'acp', '--patch', overlay, 'serve', '--port', '0'], {
  cwd: project,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', stderrFd],
})

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms))])

// Wait for the "listening" line to learn the picked port.
const port = await withTimeout(
  new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { buffer += chunk })
    child.stderr = undefined
    const timer = setInterval(() => {
      try {
        const text = readFileSync(stderrLog, 'utf8')
        const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match !== null) { clearInterval(timer); resolve(Number(match[1])) }
      } catch { /* log not written yet */ }
    }, 300)
    setTimeout(() => { clearInterval(timer); reject(new Error('serve never reported a listening port')) }, 90_000)
  }),
  120_000,
  'serve port',
)
PASS(`serve listening on :${port}`)

// ── HTTP+SSE ACP client ────────────────────────────────────────────────────
const base = `http://127.0.0.1:${port}`
let nextId = 1
const pending = new Map()
const notifications = []

async function openStream(connectionId) {
  const response = await fetch(`${base}/acp/stream`, { headers: { 'acp-connection-id': connectionId } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (!event.startsWith('data: ')) continue // heartbeat comments
        const message = JSON.parse(event.slice(6))
        if (message.id !== undefined && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error !== undefined) reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`))
          else resolve(message.result)
        } else if (message.method !== undefined) {
          notifications.push(message)
        }
      }
    }
  })()
}

async function post(body, connectionId) {
  const response = await fetch(`${base}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(connectionId !== undefined ? { 'acp-connection-id': connectionId } : {}) },
    body: JSON.stringify(body),
  })
  return response
}

const send = (connectionId, method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    void post({ jsonrpc: '2.0', id, method, params }, connectionId).then((response) => {
      assert.equal(response.status, 202, `${method} POST accepted`)
    })
  })

// ── the conversation ───────────────────────────────────────────────────────
try {
  const health = await fetch(`${base}/healthz`)
  assert.equal(await health.text(), 'ok')
  PASS('healthz')

  const ui = await fetch(`${base}/`)
  assert.equal(ui.status, 200)
  assert.match(ui.headers.get('content-type') ?? '', /text\/html/)
  const html = await ui.text()
  assert.ok(html.includes('data-acp-webui') && html.includes('session/prompt'))
  PASS('built-in web UI served at GET /')

  const initResponse = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {
    protocolVersion: 1,
    clientCapabilities: { _meta: { 'dsh/extensions': { version: 1 } } },
  } })
  assert.equal(initResponse.status, 200)
  const connectionId = initResponse.headers.get('acp-connection-id') ?? ''
  assert.match(connectionId, /^[0-9a-f-]{36}$/)
  const initBody = JSON.parse(await initResponse.text())
  assert.equal(initBody.result.agentInfo.name, 'dsh-e2e')
  PASS(`initialize (200, connection ${connectionId.slice(0, 8)}, agentName=dsh-e2e)`)

  await openStream(connectionId)
  PASS('SSE stream open (Acp-Connection-Id header)')

  // EventSource cannot set headers; the UI relies on the query-parameter
  // form. One connection carries ONE active stream, so probe with a second
  // connection instead of displacing the first stream. This doubles as the
  // multi-client regression: creating AND deleting a second connection must
  // not steal the first connection's notification channel (a shared context
  // bug found by this exact sequence - notifications vanished silently).
  {
    const secondInit = await post({ jsonrpc: '2.0', id: 900, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    const secondId = secondInit.headers.get('acp-connection-id') ?? ''
    const queryStream = await fetch(`${base}/acp/stream?connection=${secondId}`)
    assert.equal(queryStream.status, 200)
    assert.match(queryStream.headers.get('content-type') ?? '', /text\/event-stream/)
    await queryStream.body.cancel().catch(() => undefined)
    await fetch(`${base}/acp`, { method: 'DELETE', headers: { 'acp-connection-id': secondId } })
    PASS('SSE stream opens via ?connection= query form (used by EventSource)')
  }

  const session = await send(connectionId, 'session/new', { cwd: project, mcpServers: [] })
  assert.match(session.sessionId, /^acp-/)
  PASS(`session/new -> ${session.sessionId}`)

  const first = await withTimeout(send(connectionId, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello' }] }), 120_000, 'prompt #1')
  assert.equal(first.stopReason, 'end_turn')
  const updates = notifications
    .filter((n) => n.method === 'session/update' && n.params.sessionId === session.sessionId)
    .map((n) => n.params.update)
  if (!(updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk').length === 1)) {
    process.stderr.write(`DEBUG notifications=${JSON.stringify(notifications.slice(0, 5))}\n`)
  }
  assert.ok(updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk').length === 1)
  assert.ok(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').length >= 2)
  PASS('prompt #1 streamed thought + message chunks over SSE')

  const second = await withTimeout(send(connectionId, 'session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'CALL_TOOL now' }] }), 120_000, 'prompt #2')
  assert.equal(second.stopReason, 'end_turn')
  const secondUpdates = notifications
    .filter((n) => n.method === 'session/update' && n.params.sessionId === session.sessionId && !updates.includes(n.params.update))
    .map((n) => n.params.update)
  const toolCall = secondUpdates.find((u) => u.sessionUpdate === 'tool_call')
  assert.ok(toolCall !== undefined && toolCall.status === 'pending')
  assert.ok(secondUpdates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress'))
  const completed = secondUpdates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')
  assert.match(JSON.stringify(completed?.content ?? ''), /acp-e2e-ok/)
  PASS('prompt #2 full tool_call lifecycle over SSE')

  // ── dsh/* vendor extensions ─────────────────────────────────────────────
  const listed = await withTimeout(send(connectionId, 'dsh/sessions/list', {}), 60_000, 'dsh/sessions/list')
  assert.ok(Array.isArray(listed.sessions))
  const own = listed.sessions.find((candidate) => candidate.id === session.sessionId)
  assert.ok(own !== undefined, 'session/new session appears in dsh/sessions/list')
  assert.equal(own.acp, true)
  assert.equal(own.persisted, true)
  PASS(`dsh/sessions/list (${listed.sessions.length} sessions, own acp=true)`)

  const read = await withTimeout(send(connectionId, 'dsh/sessions/read', { sessionId: session.sessionId }), 60_000, 'dsh/sessions/read')
  assert.ok(Array.isArray(read.entries) && read.entries.length > 0, 'surface transcript is non-empty')
  assert.ok(read.entries.every((entry) => typeof entry.text === 'string' && entry.text.length > 0))
  PASS(`dsh/sessions/read (${read.entries.length} text entries)`)

  const jobsListed = await withTimeout(send(connectionId, 'dsh/jobs/list', {}), 60_000, 'dsh/jobs/list')
  assert.ok(Array.isArray(jobsListed.jobs))
  PASS(`dsh/jobs/list (${jobsListed.jobs.length} jobs)`)

  const goalsListed = await withTimeout(send(connectionId, 'dsh/goals/list', {}), 60_000, 'dsh/goals/list')
  assert.ok(Array.isArray(goalsListed.goals))
  PASS(`dsh/goals/list (${goalsListed.goals.length} goals)`)

  const skillsListed = await withTimeout(send(connectionId, 'dsh/skills/list', {}), 60_000, 'dsh/skills/list')
  assert.ok(Array.isArray(skillsListed.skills))
  PASS(`dsh/skills/list (${skillsListed.skills.length} skills)`)

  const tree = await withTimeout(send(connectionId, 'dsh/agents/tree', {}), 60_000, 'dsh/agents/tree')
  assert.ok(Array.isArray(tree.agents))
  assert.ok(tree.agents.some((node) => node.sessionId === session.sessionId && node.acp === true))
  PASS(`dsh/agents/tree (${tree.agents.length} live agents, own session present)`)

  assert.ok(notifications.some((n) => n.method === 'dsh/changed' && n.params?.topics?.includes('sessions')),
    'dsh/changed {sessions} pushed after the turn')
  PASS('dsh/changed notifications flow to the opted-in connection')

  // resume: close, then reopen the SAME persisted session by id
  await withTimeout(send(connectionId, 'session/close', { sessionId: session.sessionId }), 60_000, 'close for resume')
  const resumed = await withTimeout(send(connectionId, 'dsh/sessions/resume', { sessionId: session.sessionId }), 120_000, 'dsh/sessions/resume')
  assert.equal(resumed.sessionId, session.sessionId, 'resume reopens the persisted id')
  PASS('dsh/sessions/resume reopens the closed persisted session')

  const del = await fetch(`${base}/acp`, { method: 'DELETE', headers: { 'acp-connection-id': connectionId } })
  assert.equal(del.status, 204)
  PASS('DELETE connection -> 204')

  const orphan = await fetch(`${base}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'acp-connection-id': connectionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/cancel', params: { sessionId: 'x' } }),
  })
  assert.equal(orphan.status, 404)
  PASS('closed connection rejects further POSTs (404)')

  child.kill('SIGTERM')
  const exitCode = await withTimeout(new Promise((resolve) => child.on('exit', (code) => resolve(code))), 60_000, 'exit')
  assert.ok(exitCode === 0 || exitCode === null, `clean exit (${exitCode ?? 'signal'})`)
  PASS('SIGTERM -> clean teardown')

  process.stdout.write('SERVE E2E OK\n')
  process.exit(0)
} catch (error) {
  FAIL(String(error instanceof Error ? error.stack ?? error.message : error))
}
