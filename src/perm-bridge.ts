/**
 * Permission bridge: the DSH approval seam <-> ACP session/request_permission.
 *
 * DSH's approval service documents this exact pattern: "The ACP automation
 * bridge supplies one-shot machine decisions for sessions it owns." We are
 * the terminal answerer for our own ACP-created agent (matched by session
 * id); everything else (subagent children, foreign agents) falls through to
 * `next()` and DSH's own fail-closed policy decides.
 */
import type { AgentContext, PermissionOption, RequestPermissionResponse, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { AcpSessionEntry } from './table.js'

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface ApprovalRequestLike {
  readonly agent: { id: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
]

/** Register the agent-scoped approval answerer for one ACP session. */
export function attachPermBridge(
  agentCtx: Context,
  sessionId: string,
  entry: AcpSessionEntry,
  context: () => AgentContext | undefined,
  log: (message: string) => void,
): void {
  agentCtx.on('approval/request', (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => {
    if (String(req.agent.id) !== sessionId) return next()
    return answerViaAcp(req, entry, context, log)
  })
}

async function answerViaAcp(
  req: ApprovalRequestLike,
  entry: AcpSessionEntry,
  context: () => AgentContext | undefined,
  log: (message: string) => void,
): Promise<ApprovalOutcome> {
  const client = context()
  if (client === undefined) return 'unavailable'
  const asked: ToolCallUpdate = {
    toolCallId: req.callId ?? `permission-${req.toolName}`,
    title: req.reason ?? `Permission: ${req.toolName}`,
    kind: 'other',
    status: 'pending',
  }
  return await new Promise<ApprovalOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: ApprovalOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    if (req.signal !== undefined) {
      if (req.signal.aborted) {
        finish('cancelled')
        return
      }
      req.signal.addEventListener('abort', () => finish('cancelled'), { once: true })
    }
    client
      .request<RequestPermissionResponse>('session/request_permission', {
        sessionId: entry.sessionId,
        toolCall: asked,
        options: PERMISSION_OPTIONS,
      })
      .then((response) => {
        const outcome = response.outcome
        if (outcome.outcome === 'cancelled') {
          finish('cancelled')
          return
        }
        const chosen = PERMISSION_OPTIONS.find((option) => option.optionId === outcome.optionId)
        if (chosen === undefined) {
          finish('unavailable')
          return
        }
        // DSH approval has only one-shot grants; `allow_always` semantics
        // (remembered rules) are a bridge-level concern deferred to M2.
        finish(chosen.kind.startsWith('allow') ? 'allowed-once' : 'rejected')
      })
      .catch((error: unknown) => {
        // A cancelled turn makes the client answer with -32800.
        if (error instanceof RequestError && error.code === -32800) {
          finish('cancelled')
          return
        }
        log(`request_permission failed: ${String(error instanceof Error ? error.message : error)}`)
        finish('unavailable')
      })
  })
}
