#!/usr/bin/env node
/**
 * acp-chat — a minimal interactive ACP client for testing dsh-acp.
 *
 * Spawns the agent (default `dsh --profile acp`, or $DSH_ACPC_CMD, or the
 * command after `--`), opens one session in the current directory, and gives
 * you a REPL: type a prompt to send it, watch streaming output / tool calls /
 * plans, answer permission prompts inline.
 *
 *   node bin/acp-chat.mjs                       # dsh --profile acp
 *   DSH_ACPC_CMD='dsh --profile acp --patch mock.yml' node bin/acp-chat.mjs
 *   node bin/acp-chat.mjs -- dsh --profile acp
 *
 * REPL commands: /new (fresh session) · /close (close session) · /quit
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

// ── launch config ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const dashDash = argv.indexOf('--')
const command =
  dashDash !== -1 ? argv.slice(dashDash + 1).join(' ')
  : process.env.DSH_ACPC_CMD ?? 'dsh --profile acp'

const child = spawn(command, {
  shell: true,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
})
child.on('exit', (code) => process.exit(code ?? 0))
const stdout = Writable.toWeb(child.stdin)
const stdin = Readable.toWeb(child.stdout)

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

// ── the client app ─────────────────────────────────────────────────────────
let currentSession = undefined


const app = client({ name: 'acp-chat' })
  .onNotification('session/update', async ({ params }) => {
    if (params.sessionId === currentSession) renderUpdate(params.update)
  })
  .onRequest('session/request_permission', async ({ params }) => {
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
  })

const conn = app.connect(ndJsonStream(stdout, stdin))
const rpc = conn.agent

async function newSession() {
  const created = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] })
  currentSession = created.sessionId
  process.stdout.write(DIM(`session ${currentSession}\n`))
}

await rpc.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
await newSession()

process.stdout.write(`${BOLD('acp-chat')} → ${DIM(command)}\nType a prompt, or /new /close /quit.\n`)

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
      conn.close()
      child.stdin.end()
      setTimeout(() => child.kill('SIGTERM'), 3000).unref()
    })
})
