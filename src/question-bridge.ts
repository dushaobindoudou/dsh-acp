/**
 * Question bridge: dsh user questions (`ask_user_question`, plan review —
 * the `user-questions/request` waterfall) <-> the ACP client.
 *
 * Without it an ACP-driven agent that asks the user something has no
 * answerer: the waterfall ends at NO_PROVIDER and the tool fails. The
 * bridge answers for the session it is attached to, in order:
 *
 *  1. `permissionPolicy: auto` — the first (recommended) option of every
 *     question, no round trip; `deny` — every question skipped.
 *  2. a client that declared `elicitation.form` — one form-mode
 *     `elicitation/create` covering the whole batch.
 *  3. any other bound client — `session/request_permission` with one button
 *     per option, when the batch is a single single-select question.
 *  4. otherwise `next()`: the web GUI answers in a web composition.
 */
import type { AgentContext, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { AcpSessionEntry } from './table.js'
import { supportsFormElicitation } from './connections.js'
import {
  answersFromElicitation,
  answersFromPermission,
  autoAnswerOf,
  elicitationOf,
  permissionFallbackOf,
  SKIP_OPTION_ID,
  type QuestionAnswer,
  type QuestionItem,
} from './question-map.js'

interface QuestionRequestLike {
  readonly questions: readonly QuestionItem[]
  readonly agent?: { id: string }
  readonly signal?: AbortSignal
  readonly wait?: { callId: string; timed?: boolean }
}

/** Register the agent-scoped question answerer; returns its disposer. */
export function attachQuestionBridge(
  agentCtx: Context,
  entry: AcpSessionEntry,
  log: (message: string) => void,
): () => unknown {
  // `user-questions/request` is declared by dsh-user-questions, which this
  // package does not depend on; the loose cast keeps the listener typed
  // against the structural request instead of pulling the module in.
  const on = agentCtx.on as unknown as (
    name: string,
    listener: (request: QuestionRequestLike, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>,
    options: { prepend: boolean },
  ) => () => unknown
  return on.call(agentCtx, 'user-questions/request', (request, next) => {
    if (request.agent !== undefined && String(request.agent.id) !== entry.sessionId) return next()
    if (entry.permissionPolicy === 'auto') {
      log(`question auto-answered (policy auto) in ${entry.sessionId}`)
      return Promise.resolve(autoAnswerOf(request.questions))
    }
    if (entry.permissionPolicy === 'deny') return Promise.resolve(autoSkip(request.questions))
    const client = entry.client
    if (client === undefined) return next()
    if (supportsFormElicitation(client)) return askByElicitation(client, entry, request, log)
    const buttons = permissionFallbackOf(request.questions)
    if (buttons !== undefined) return askByPermission(client, entry, request, buttons, log)
    return next()
    // Prepended for the same reason as the permission bridge: the GUI's
    // forwarding answerer would otherwise hold the question for a browser.
  }, { prepend: true })
}

function autoSkip(questions: readonly QuestionItem[]): QuestionAnswer {
  return { answers: questions.map((question) => ({ id: question.id, selected: [] })) }
}

/** Race a client round trip against the question's own cancellation. */
function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal === undefined) return work()
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('question aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('question aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error('question aborted')
      return work()
    }).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function askByElicitation(
  client: AgentContext,
  entry: AcpSessionEntry,
  request: QuestionRequestLike,
  log: (message: string) => void,
): Promise<QuestionAnswer> {
  const params = elicitationOf(entry.sessionId, request.wait?.callId, request.questions)
  const send = client.request as unknown as (method: string, params: unknown) => Promise<{ action: string; content?: Record<string, unknown> | null }>
  const response = await abortable(request.signal, () => send.call(client, 'elicitation/create', params))
  if (response.action === 'accept') return answersFromElicitation(request.questions, response.content)
  if (response.action === 'decline') {
    // An explicit refusal is an answer: every question skipped, the model
    // continues. Only a dismissed dialog (cancel) fails the ask.
    log(`question declined by the client in ${entry.sessionId}`)
    return autoSkip(request.questions)
  }
  throw new Error('the user dismissed the question')
}

async function askByPermission(
  client: AgentContext,
  entry: AcpSessionEntry,
  request: QuestionRequestLike,
  options: NonNullable<ReturnType<typeof permissionFallbackOf>>,
  log: (message: string) => void,
): Promise<QuestionAnswer> {
  const question = request.questions[0]!
  try {
    const response = await abortable<RequestPermissionResponse>(request.signal, () => client.request('session/request_permission', {
      sessionId: entry.sessionId,
      toolCall: {
        toolCallId: request.wait?.callId ?? `question-${question.id}`,
        title: question.header !== undefined ? `${question.header}: ${question.question}` : question.question,
        kind: 'other',
        status: 'pending',
      },
      options,
    }))
    const outcome = response.outcome
    if (outcome.outcome === 'cancelled') throw new Error('the user dismissed the question')
    return outcome.optionId === SKIP_OPTION_ID
      ? autoSkip(request.questions)
      : answersFromPermission(request.questions, outcome.optionId)
  } catch (error) {
    if (error instanceof RequestError && error.code === -32800) throw new Error('the question was cancelled')
    log(`question fallback failed: ${String(error instanceof Error ? error.message : error)}`)
    throw error
  }
}
