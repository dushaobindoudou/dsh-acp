#!/usr/bin/env node
/**
 * acp-chat - a minimal interactive ACP client for dsh-acp.
 *
 * Local mode spawns the agent and speaks stdio; remote mode (--url) talks to
 * a `dsh --profile acp serve` endpoint over HTTP+SSE from anywhere.
 *
 *   node bin/acp-chat.mjs                          # dsh --profile acp (stdio)
 *   DSH_ACPC_CMD='dsh --profile acp --patch m.yml' node bin/acp-chat.mjs
 *   node bin/acp-chat.mjs --url http://127.0.0.1:7800        # remote
 *   node bin/acp-chat.mjs --url http://agent.lan:7800 --token s3cret
 *
 * REPL commands: /new (fresh session) · /close (close session) · /quit
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

// ── arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const url = flag('url', process.env.ACP_CHAT_URL ?? undefined)
const token = flag('token', process.env.ACP_CHAT_TOKEN ?? undefined)
const dashDash = argv.indexOf('--')
const command =
  dashDash !== -1 ? argv.slice(dashDash + 1).join(' ')
  : process.env.DSH_ACPC_CMD ?? 'dsh --profile acp'

// ── pretty printing ────────────────────────────────────────────────────────
const DIM = (s) => `\x1b[2m${s}\x1b[0m`
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const RED = (s) => `\x1b[31m${s}\x1b[0m`

let streaming = false

function renderUpdate(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (!streaming) { process.stdout.write(CYAN('agent: ')); streaming = true }
      process.stdout.write(update.content.type === 'text' ? update.content.text : '')
      break
    case 'agent_thought_chunk':
      process.stdout.write(DIM(update.content.type === 'text' ? update.content.text : ''))
      break
    case 'tool_call':
      if (streaming) { process.stdout.write('\n'); streaming = false }
      process.stdout.write(`  ${YELLOW('⚙')} ${update.title ?? update.toolCallId} ${DIM(`[${update.kind ?? 'other'}] pending`)}\n`)
      break
    case 'tool_call_update': {
      if (streaming && update.status !== undefined) { process.stdout.write('\n'); streaming = false }
      const mark = update.status === 'completed' ? GREEN('✓') : update.status === 'failed' ? RED('✗') : YELLOW('⋯')
      const text = (update.content ?? [])
        .filter((c) => c.type === 'content' && c.content.type === 'text')
        .map((c) => c.content.text.trim())
        .join(' ')
        .replace(/\n/g, ' ')
        .slice(0, 120)
      process.stdout.write(`  ${mark} ${update.status ?? ''}${text.length > 0 ? ` ${DIM(text)}` : ''}\n`)
      break
    }
    case 'plan': {
      if (streaming) { process.stdout.write('\n'); streaming = false }
      process.stdout.write(BOLD('  plan:\n'))
      for (const entry of update.entries ?? []) {
        const icon = entry.status === 'completed' ? GREEN('x') : entry.status === 'in_progress' ? YELLOW('>') : ' '
        process.stdout.write(`    [${icon}] ${entry.content}\n`)
      }
      break
    }
    default:
      break
  }
}

let currentSession = undefined

function handleNotification(method, params) {
  if (method === 'session/update' && params.sessionId === currentSession) renderUpdate(params.update)
}

async function askPermission(params) {
  if (streaming) { process.stdout.write('\n'); streaming = false }
  process.stdout.write(`\n${BOLD('permission needed:')} ${params.toolCall.title ?? params.toolCall.toolCallId}\n`)
  params.options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option.name}\n`)
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let choice
  while (true) {
    const answer = await rl.question('choose [1]: ')
    if (answer.trim() === '') { choice = params.options[0]; break }
    const index = Number(answer) - 1
    if (Number.isInteger(index) && index >= 0 && index < params.options.length) {
      choice = params.options[index]
      break
    }
  }
  rl.close()
  return { outcome: { outcome: 'selected', optionId: choice.optionId } }
}

// ── transport: local stdio or remote HTTP+SSE ──────────────────────────────
let rpc
let describeTarget
let shutdown

if (url === undefined) {
  const child = spawn(command, {
    shell: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  const app = client({ name: 'acp-chat' })
    .onNotification('session/update', async ({ params }) => handleNotification('session/update', params))
    .onRequest('session/request_permission', async ({ params }) => askPermission(params))
  const conn = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  rpc = conn.agent
  describeTarget = command
  shutdown = async () => {
    conn.close()
    child.stdin.end()
    setTimeout(() => child.kill('SIGTERM'), 3000).unref()
  }
} else {
  const headers = () => ({
    'content-type': 'application/json',
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  })
  let connectionId = undefined
  let nextId = 100
  const pending = new Map()
  const serverRequests = new Map()

  async function post(message) {
    const response = await fetch(`${url.replace(/\/$/, '')}/acp`, {
      method: 'POST',
      headers: { ...headers(), ...(connectionId !== undefined ? { 'acp-connection-id': connectionId } : {}) },
      body: JSON.stringify(message),
    })
    if (!response.ok && response.status !== 202) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }
    return response
  }

  function dispatch(message) {
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`))
      else resolve(message.result)
    } else if (message.method !== undefined) {
      if (message.method === 'session/update') {
        handleNotification('session/update', message.params)
      } else if (message.method === 'session/request_permission') {
        void askPermission(message.params)
          .then((result) => post({ jsonrpc: '2.0', id: message.id, result }))
          .catch(() => post({ jsonrpc: '2.0', id: message.id, error: { code: -32800, message: 'cancelled' } }))
      }
    }
  }

  async function openStream() {
    const response = await fetch(`${url.replace(/\/$/, '')}/acp/stream`, {
      headers: { ...headers(), ...(connectionId !== undefined ? { 'acp-connection-id': connectionId } : {}) },
    })
    if (!response.ok || response.body === null) throw new Error(`SSE open failed: HTTP ${response.status}`)
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
          if (event.startsWith('data: ')) dispatch(JSON.parse(event.slice(6)))
        }
      }
    })()
  }

  const initResponse = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } })
  if (initResponse.status !== 200) throw new Error(`initialize failed: HTTP ${initResponse.status}`)
  connectionId = initResponse.headers.get('acp-connection-id') ?? ''
  dispatch(JSON.parse(await initResponse.text()))
  await openStream()

  rpc = {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        void post({ jsonrpc: '2.0', id, method, params }).catch(reject)
      })
    },
  }
  describeTarget = `${url} (connection ${connectionId.slice(0, 8)})`
  shutdown = async () => {
    await fetch(`${url.replace(/\/$/, '')}/acp`, {
      method: 'DELETE',
      headers: { ...headers(), 'acp-connection-id': connectionId },
    }).catch(() => undefined)
  }
}

async function newSession() {
  const created = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] })
  currentSession = created.sessionId
  process.stdout.write(DIM(`session ${currentSession}\n`))
}

process.stdout.write(`${BOLD('acp-chat')} -> ${DIM(describeTarget)}\nType a prompt, or /new /close /quit.\n`)

// ── REPL ───────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: BOLD('you: ') })

async function handleLine(text) {
  if (text === '') return
  if (text === '/quit' || text === '/exit') { rl.close(); return }
  if (text === '/new') { await newSession(); return }
  if (text === '/close') {
    if (currentSession !== undefined) await rpc.request('session/close', { sessionId: currentSession })
    currentSession = undefined
    process.stdout.write(DIM('session closed (next prompt starts a new one)\n'))
    return
  }
  if (currentSession === undefined) await newSession()
  const response = await rpc.request('session/prompt', {
    sessionId: currentSession,
    prompt: [{ type: 'text', text }],
  })
  if (streaming) { process.stdout.write('\n'); streaming = false }
  process.stdout.write(DIM(`  [${response.stopReason}]\n`))
}

// Serialize: one line fully handled (prompt completed) before the next.
let queue = Promise.resolve()
rl.on('line', (line) => {
  queue = queue
    .then(() => handleLine(line.trim()))
    .catch((error) => {
      if (streaming) { process.stdout.write('\n'); streaming = false }
      process.stdout.write(RED(`error: ${String(error instanceof Error ? error.message : error)}\n`))
    })
    .then(() => { if (rl.closed !== true) rl.prompt() })
})

rl.prompt()

rl.on('close', () => {
  // Piped stdin EOFs immediately after its lines; let the queued prompts
  // finish before tearing the connection down.
  void queue
    .catch(() => undefined)
    .then(async () => {
      try {
        if (currentSession !== undefined) await rpc.request('session/close', { sessionId: currentSession })
      } catch { /* agent may already be gone */ }
      await shutdown()
      setTimeout(() => process.exit(0), 200).unref()
    })
})
