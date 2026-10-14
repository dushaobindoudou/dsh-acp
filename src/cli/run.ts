/**
 * The one-shot `run` CLI: drive one dsh task from a script WITHOUT speaking
 * ACP yourself. It talks to a RUNNING server (`--url` / DSH_ACP_URL: serve,
 * or the web composition's /acp) or spawns a private `dsh --profile acp`
 * stdio server, and drives it through the same SDK client every other ACP
 * client uses — no second protocol, no bypass.
 *
 *   dsh-acp-server run "fix the failing tests" --cwd . --json \
 *     --model liepin/glm-5-3 --timeout 600 --permission-policy auto
 *   dsh-acp-server run "long refactor" --url http://127.0.0.1:3080 --detach \
 *     --permission-policy auto        # prints the sessionId and returns at once
 *
 * stdout carries ONLY the result (the final answer's plain text, or one JSON
 * object with --json); progress (tool calls, permission asks) goes to stderr.
 * Exit codes: 0 done · 1 error · 2 timeout · 3 cancelled · 4 permission denied.
 */
import { Command } from 'commander'
import type { ContentBlock, RequestPermissionOutcome, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { basename } from 'node:path'
import {
  buildPromptBlocks,
  exitCodeFor,
  finalTextOf,
  isDenyingOutcome,
  jsonResultOf,
  parseModelSpec,
  permissionAnswer,
  type Attachment,
  type CollectedUpdate,
  type PermissionPolicy,
} from './run-core.js'
import { openServer, settle, targetOf, type ServerTarget } from './connect.js'
import { autoFormContent, positiveNumberArg, questionsOfForm, replyToContent } from './control-core.js'

export interface RunOptions {
  readonly task: string
  readonly cwd: string
  readonly json: boolean
  /** Resume (or attach to) this session instead of creating one. */
  readonly session?: string
  /** Temporary `<provider>/<model>` override via session/set_config_option. */
  readonly model?: string
  /** Seconds before the turn is cancelled (exit 2). */
  readonly timeoutSeconds?: number
  readonly permissionPolicy: PermissionPolicy
  readonly attach: readonly string[]
  /** Running server; absent spawns a private child. */
  readonly url?: string
  readonly token?: string
  /** Dispatch the task and return immediately (requires a running server). */
  readonly detach: boolean
  /** Agent preset of a new session (web compositions; see `call agentPresets/list`). */
  readonly preset?: string
  /** Child command override (tests); default `$DSH_BIN/dsh --profile acp`. */
  readonly command?: readonly string[]
}

export function parseRunArgv(argv: readonly string[]): RunOptions {
  const program = new Command()
    .name('dsh-acp-server run')
    .description('run one dsh task through the ACP server and print the answer')
    .argument('<task>', 'the task description sent to the agent')
    .option('--cwd <dir>', 'working directory for the session', process.cwd())
    .option('--json', 'print one machine-readable JSON object instead of plain text', false)
    .option('--session <id>', 'resume (or attach to a live) session instead of creating one')
    .option('--model <provider/model>', 'temporary model override (session/set_config_option)')
    .option('--timeout <seconds>', 'cancel the turn after this many seconds (exit 2)', (value: string) => positiveNumberArg(value, '--timeout'))
    .option('--permission-policy <policy>', 'auto | ask | deny (also answers agent questions: auto picks the first option)', (value: string): PermissionPolicy => {
      if (value !== 'auto' && value !== 'ask' && value !== 'deny') {
        throw new Error(`--permission-policy expects auto|ask|deny, got: ${value}`)
      }
      return value
    }, 'ask')
    .option('--attach <file>', 'attach a file (repeatable; images ride image blocks, other files are inlined as text)', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--url <url>', 'running server base URL (serve / web composition); default $DSH_ACP_URL, else spawn a private dsh')
    .option('--token <token>', 'bearer token for --url; default $DSH_ACP_TOKEN')
    .option('--detach', 'dispatch the task and return at once with the sessionId (needs a running server)', false)
    .option('--preset <id>', 'agent preset for a new session (web compositions: standard, ptc, minimal, ...)')
  program.parse([...argv], { from: 'user' })
  const options = program.opts()
  return {
    task: program.args[0] ?? '',
    cwd: options.cwd as string,
    json: options.json as boolean,
    session: options.session as string | undefined,
    model: options.model as string | undefined,
    timeoutSeconds: options.timeout as number | undefined,
    permissionPolicy: options.permissionPolicy as PermissionPolicy,
    attach: options.attach as string[],
    url: options.url as string | undefined,
    token: options.token as string | undefined,
    detach: options.detach as boolean,
    preset: options.preset as string | undefined,
  }
}

const err = (message: string): void => { process.stderr.write(`dsh-acp-server run: ${message}\n`) }

export async function runMain(argv: readonly string[]): Promise<number> {
  let options: RunOptions
  try {
    options = parseRunArgv(argv)
  } catch (error) {
    err(String(error instanceof Error ? error.message : error))
    return 1
  }
  if (options.task.length === 0) {
    err('a task description is required')
    return 1
  }
  try {
    return await runOneShot(options)
  } catch (error) {
    err(String(error instanceof Error ? error.message : error))
    return 1
  }
}

/** Read every --attach file up front so a bad path fails before any boot. */
async function loadAttachments(paths: readonly string[]): Promise<Attachment[]> {
  return Promise.all(paths.map(async (path) => ({ name: basename(path), bytes: await readFile(path) })))
}

export async function runOneShot(options: RunOptions): Promise<number> {
  let attachments: Attachment[]
  try {
    attachments = await loadAttachments(options.attach)
  } catch (error) {
    err(`--attach failed: ${String(error instanceof Error ? error.message : error)}`)
    return 1
  }
  if (options.model !== undefined) {
    try {
      parseModelSpec(options.model)
    } catch (error) {
      err(String(error instanceof Error ? error.message : error))
      return 1
    }
  }
  const target: ServerTarget = {
    ...targetOf({ url: options.url, token: options.token, cwd: options.cwd }),
    ...options.command !== undefined ? { command: options.command } : {},
  }
  if (options.detach && target.url === undefined) {
    err('--detach needs a running server (--url or DSH_ACP_URL): a private child would die with this process')
    return 1
  }

  const updates: CollectedUpdate[] = []
  let sessionId = options.session ?? ''
  let permissionDenied = false

  // The SDK's outcome union contains an intersection member, which defeats
  // literal widening for object literals nested in a return position; build
  // the outcome against the union type first, then wrap it in the response.
  const selected = (optionId: string): RequestPermissionOutcome => ({ outcome: 'selected', optionId })
  const cancelled: RequestPermissionOutcome = { outcome: 'cancelled' }

  const askPermission = async (params: {
    options: ReadonlyArray<{ optionId: string; name: string; kind: string }>
  }): Promise<RequestPermissionResponse> => {
    const scripted = permissionAnswer(options.permissionPolicy, params.options)
    if (scripted !== undefined) {
      if (isDenyingOutcome({ outcome: 'selected', optionId: scripted.optionId }, params.options)) {
        permissionDenied = true
        err(`permission denied by policy: ${scripted.optionId}`)
      } else {
        err(`permission auto-approved: ${scripted.optionId}`)
      }
      return { outcome: selected(scripted.optionId) }
    }
    // Interactive ask. A non-TTY stdin has nobody to ask: deny (fail closed).
    if (process.stdin.isTTY !== true) {
      permissionDenied = true
      err('permission requested but stdin is not a TTY; denying (use --permission-policy auto)')
      return { outcome: cancelled }
    }
    err(`permission needed: ${params.options.map((option, index) => `${index + 1}. ${option.name}`).join('  ')}`)
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const answer = await rl.question('choose [1]: ')
        if (answer.trim() === '') return { outcome: selected(params.options[0]?.optionId ?? '') }
        const index = Number(answer) - 1
        const choice = Number.isInteger(index) && index >= 0 ? params.options[index] : undefined
        if (choice !== undefined) {
          if (choice.kind.startsWith('reject')) permissionDenied = true
          return { outcome: selected(choice.optionId) }
        }
      }
    } finally {
      rl.close()
    }
  }

  /** Agent questions (ask_user_question) arrive as form-mode elicitations. */
  const answerQuestions = async (params: { message?: string; requestedSchema?: { properties?: Record<string, unknown> } }) => {
    const questions = questionsOfForm(params.requestedSchema)
    if (options.permissionPolicy === 'deny') {
      err('agent question declined by policy')
      return { action: 'decline' as const }
    }
    if (options.permissionPolicy === 'auto' || process.stdin.isTTY !== true) {
      if (options.permissionPolicy !== 'auto') err('agent asked a question but stdin is not a TTY; answering with the first options')
      else err('agent question auto-answered with the first options')
      return { action: 'accept' as const, content: autoFormContent(questions) }
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const content: Record<string, unknown> = {}
      for (const question of questions) {
        process.stderr.write(`\n? ${question.title}${question.description !== undefined ? `\n  ${question.description}` : ''}\n`)
        for (const [index, choice] of question.choices.entries()) process.stderr.write(`  ${index + 1}. ${choice}\n`)
        const prompt = question.choices.length === 0 ? 'answer: ' : question.multi ? 'choose (e.g. 1,3) or type [1]: ' : 'choose or type [1]: '
        Object.assign(content, replyToContent(question, await rl.question(prompt)))
      }
      return { action: 'accept' as const, content }
    } finally {
      rl.close()
    }
  }

  const server = await openServer(target, (app) => app
    .onNotification('session/update', async ({ params }) => {
      if (params.sessionId !== sessionId) return
      const update = params.update as CollectedUpdate
      updates.push(update)
      if (!options.json && update.sessionUpdate === 'tool_call') {
        process.stderr.write(`  tool: ${update.title ?? update.toolCallId}\n`)
      }
    })
    .onRequest('session/request_permission', async ({ params }) => askPermission(params))
    .onRequest('elicitation/create', async ({ params }) => answerQuestions(params as never) as never),
  { elicitation: { form: {} } })
  const rpc = server.rpc

  try {
    if (options.session !== undefined) {
      sessionId = options.session
      // session/resume attaches to a live session (the GUI's, a detached
      // task) or resumes a persisted one; either way it is ours to drive.
      await settle(server, rpc.request('session/resume', { sessionId, cwd: options.cwd, mcpServers: [] }), 'session/resume')
    } else {
      const created = await settle(server, rpc.request('session/new', {
        cwd: options.cwd,
        mcpServers: [],
        ...options.preset !== undefined ? { _meta: { 'dsh/agentPreset': options.preset } } : {},
      }), 'session/new')
      sessionId = created.sessionId
    }

    if (options.model !== undefined) {
      const { provider, model } = parseModelSpec(options.model)
      await settle(server, rpc.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: `${provider}/${model}`,
      }), 'session/set_config_option')
      err(`model override: ${provider}/${model}`)
    }

    const promptBlocks: ContentBlock[] = buildPromptBlocks(options.task, attachments)

    if (options.detach) {
      // The server answers permissions/questions itself from here on: no
      // client stays bound to ask. The session outlives this connection
      // until its turn settles; poll it with `rpc dsh/sessions/wait`.
      const accepted = await settle(server, rpc.request<{ status?: string }>('dsh/sessions/prompt', {
        sessionId,
        prompt: promptBlocks,
        permissionPolicy: options.permissionPolicy,
      }), 'dsh/sessions/prompt')
      if (options.json) process.stdout.write(`${JSON.stringify({ sessionId, detached: true, status: accepted.status }, null, 2)}\n`)
      else process.stdout.write(`${sessionId}\n`)
      return 0
    }

    const timeout = options.timeoutSeconds !== undefined && options.timeoutSeconds > 0
      ? options.timeoutSeconds * 1000
      : undefined
    const cancellation = new AbortController()
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      err(`timeout after ${options.timeoutSeconds}s; cancelling the turn`)
      // Aborting the request signal makes the SDK send $/cancel_request; the
      // notification repeats it for servers that key on the method instead.
      cancellation.abort()
      void rpc.notify('session/cancel', { sessionId }).catch(() => undefined)
    }, timeout)
    timer?.unref?.()

    let stopReason: string | undefined
    let usage: Record<string, unknown> | undefined
    let error: string | undefined
    try {
      const response = await settle(server, rpc.request('session/prompt', {
        sessionId,
        prompt: promptBlocks,
      }, { cancellationSignal: cancellation.signal }), 'the prompt')
      stopReason = response.stopReason
      usage = response.usage as Record<string, unknown> | undefined
    } catch (requestError) {
      const cancelledByTimeout = cancellation.signal.aborted
      if (cancelledByTimeout) {
        stopReason = 'cancelled' // settled below by exitCodeFor via timedOut
      } else {
        error = requestError instanceof Error ? requestError.message : String(requestError)
      }
    }
    clearTimeout(timer)

    // Close the session: dispose an owned agent (the persisted log survives
    // for --session), or only detach from an adopted one.
    await rpc.request('session/close', { sessionId }).catch(() => undefined)
    const outcome = {
      sessionId,
      updates,
      usage,
      error,
      timedOut: cancellation.signal.aborted,
      stopReason,
      permissionDenied,
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(jsonResultOf(outcome), null, 2)}\n`)
    } else {
      const text = finalTextOf(updates)
      if (text.length > 0) process.stdout.write(`${text}\n`)
    }
    if (error !== undefined) err(`error: ${error}`)
    return exitCodeFor(outcome)
  } finally {
    await server.close().catch(() => undefined)
  }
}
