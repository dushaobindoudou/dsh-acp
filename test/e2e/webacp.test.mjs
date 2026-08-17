/**
 * End-to-end web-mounted test: the Web GUI and the ACP endpoint in ONE
 * process on ONE port (`dsh plugin --profile web add dsh-acp-server` plus the
 * row-level inject). Asserts the GUI still serves `/`, ACP serves `/acp*` on
 * the same port, and a full mock conversation streams over SSE - while the
 * process stays alive (the stdio branch never runs).
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshBin = process.env.DSH_BIN ?? 'dsh'

const PASS = (message) => process.stdout.write(`  ok - ${message}\n`)
const FAIL = (message) => {
  process.stderr.write(`  not ok - ${message}\n`)
  for (const path of ['/tmp/dsh-acp-web-out.log', '/tmp/dsh-acp-web-err.log']) {
    if (existsSync(path)) process.stderr.write(`--- ${path} ---\n${readFileSync(path, 'utf8').slice(-3000)}\n`)
  }
  process.exit(1)
}

// ── combined profile in a throwaway home ───────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'dsh-acp-web-'))
const home = join(tmp, 'home')
const project = join(tmp, 'project')
mkdirSync(project, { recursive: true })

// `web` is a shipped profile template, so this bootstraps base+web-app plus
// our bundle through the official command.
const install = spawnSync(dshBin, ['plugin', '--profile', 'web', 'add', process.env.DSH_ACP_PKG ?? repoRoot], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
  timeout: 240_000,
})
if (install.status !== 0) {
  process.stderr.write(install.stdout ?? '')
  process.stderr.write(install.stderr ?? '')
  FAIL('dsh plugin --profile web add failed')
}
PASS('installed dsh-acp-server into the web profile')

// Row-level inject: deterministic web-mounted mode (the row waits for the
// shared webServer service instead of racing it into the stdio branch).
// The template's patch file ships the placeholder `[]`; a YAML file is one
// document, so replace the placeholder instead of appending after it.
const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
const previous = readFileSync(patchPath, 'utf8')
const entries = ['# dsh-acp-server: web-mounted mode - ACP rides the shared webServer port', '- id: acp-server', '  inject: [agents, agentDefaultModel, webServer]'].join('\n')
writeFileSync(patchPath, /\[\]\s*$/m.test(previous) ? previous.replace(/\[\]\s*$/m, entries) : `${previous.trimEnd()}\n${entries}\n`)

// ── boot ───────────────────────────────────────────────────────────────────
const overlay = join(repoRoot, 'test', 'e2e', 'test-acp.overlay.yml')
const outLog = '/tmp/dsh-acp-web-out.log'
const { openSync } = await import('node:fs')
const child = spawn(dshBin, ['--profile', 'web', '--patch', overlay, '--port', '0'], {
  cwd: project,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', openSync(outLog, 'w'), openSync('/tmp/dsh-acp-web-err.log', 'w')],
})

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms))])

const port = await withTimeout(
  new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const match = readFileSync(outLog, 'utf8').match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
        if (match !== null) { clearInterval(timer); resolve(Number(match[1])) }
      } catch { /* not written yet */ }
    }, 300)
    child.on('exit', () => { clearInterval(timer); reject(new Error('process exited before listening')) })
    setTimeout(() => { clearInterval(timer); reject(new Error('no listening line')) }, 90_000)
  }),
  120_000,
  'web port',
)
PASS(`web composition listening on :${port} (process ${child.pid})`)

// ── same-port checks ───────────────────────────────────────────────────────
const base = `http://127.0.0.1:${port}`
try {
  const gui = await fetch(`${base}/`)
  assert.equal(gui.status, 200)
  PASS('GUI / -> 200 on the shared port')

  assert.equal(await (await fetch(`${base}/acp/healthz`)).text(), 'ok')
  PASS('ACP /acp/healthz -> ok on the SAME port')

  let nextId = 1
  const pending = new Map()
  const notifications = []

  const initResponse = await fetch(`${base}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
  })
  assert.equal(initResponse.status, 200)
  const connectionId = initResponse.headers.get('acp-connection-id') ?? ''
  assert.match(connectionId, /^[0-9a-f-]{36}$/)
  const initBody = JSON.parse(await initResponse.text())
  assert.equal(initBody.result.agentInfo.name, 'dsh-e2e') // overlay config applied on top of the inject
  PASS('initialize -> 200 (agentName=dsh-e2e via overlay)')

  const stream = await fetch(`${base}/acp/stream`, { headers: { 'acp-connection-id': connectionId } })
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (!event.startsWith('data: ')) continue
        const message = JSON.parse(event.slice(6))
        if (message.id !== undefined && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error !== undefined) reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`))
          else resolve(message.result)
        } else if (message.method !== undefined) notifications.push(message)
      }
      }
    } catch { /* stream torn down at teardown */ }
  })()
  PASS('SSE stream open on the shared port')

  const send = (method, params) =>
    withTimeout(new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      void fetch(`${base}/acp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'acp-connection-id': connectionId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }).then((response) => assert.equal(response.status, 202))
    }), 120_000, method)

  const session = await send('session/new', { cwd: project, mcpServers: [] })
  assert.match(session.sessionId, /^acp-/)
  PASS(`session/new -> ${session.sessionId}`)

  const prompt = await send('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello' }] })
  assert.equal(prompt.stopReason, 'end_turn')
  const updates = notifications.filter((n) => n.method === 'session/update').map((n) => n.params.update)
  assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk'))
  PASS('prompt streamed message chunks over SSE')

  // The stdio branch never ran: the process must still be alive after the
  // whole conversation (a raced boot would have exited on stdin EOF).
  assert.ok(child.exitCode === null, `process still alive (exitCode=${child.exitCode})`)
  PASS('process alive: web mode never took the stdio branch')

  child.kill('SIGTERM')
  await withTimeout(new Promise((resolve) => child.on('exit', resolve)), 60_000, 'exit')
  PASS('SIGTERM -> clean teardown')

  process.stdout.write('WEB-AC E2E OK\n')
  process.exit(0)
} catch (error) {
  FAIL(String(error instanceof Error ? error.stack ?? error.message : error))
}
