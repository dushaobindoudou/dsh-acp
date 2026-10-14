/**
 * Pure mapping logic for the one-shot `run` CLI. No process, no spawn, no
 * SDK imports — everything here is unit-testable, mirroring translate.ts.
 */
import type { ContentBlock } from '@agentclientprotocol/sdk'

/** Exit codes: the CLI's whole contract with orchestrators. */
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_TIMEOUT = 2
export const EXIT_CANCELLED = 3
export const EXIT_PERMISSION_DENIED = 4

export type PermissionPolicy = 'auto' | 'ask' | 'deny'

/** One permission option as it arrives in `session/request_permission`. */
export interface PermissionOptionLike {
  readonly optionId: string
  readonly kind: string
}

/**
 * The one-shot answer for a permission request under a fixed policy.
 * `ask` returns `undefined` — the interactive layer decides.
 */
export function permissionAnswer(
  policy: PermissionPolicy,
  options: readonly PermissionOptionLike[],
): { outcome: 'selected'; optionId: string } | undefined {
  if (policy === 'ask' || options.length === 0) return undefined
  const prefer = policy === 'auto' ? 'allow' : 'reject'
  // allow_once over allow_always (and reject_once over reject_always): a
  // one-shot grant is the smallest commitment that unblocks the turn.
  const ranked = [...options].sort((a, b) => rankOf(b) - rankOf(a))
  function rankOf(option: PermissionOptionLike): number {
    if (option.kind === `${prefer}_once`) return 2
    if (option.kind === `${prefer}_always`) return 1
    return -1
  }
  const best = ranked[0]
  if (best === undefined || !best.kind.startsWith(prefer)) return undefined
  return { outcome: 'selected', optionId: best.optionId }
}

/** `true` when the chosen outcome denies the request (drives exit code 4). */
export function isDenyingOutcome(outcome: { outcome: string; optionId?: string }, options: readonly PermissionOptionLike[]): boolean {
  if (outcome.outcome === 'cancelled') return false
  const chosen = options.find((option) => option.optionId === outcome.optionId)
  return chosen !== undefined && chosen.kind.startsWith('reject')
}

/** An attachment handed over from the CLI layer (already read from disk). */
export interface Attachment {
  readonly name: string
  readonly bytes: Uint8Array
}

/** Image extensions the server's attachments path accepts. */
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Image block as the ACP prompt carries it. */
export interface PromptImageBlock {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

/**
 * Fold the task text plus every attachment into prompt blocks: images ride
 * the image block (the server persists them through dsh attachments),
 * everything else is inlined as fenced text under its file name.
 */
export function buildPromptBlocks(task: string, attachments: readonly Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: task }]
  for (const attachment of attachments) {
    const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()!.toLowerCase() : ''
    const mimeType = IMAGE_MIME_BY_EXTENSION[extension]
    if (mimeType !== undefined) {
      blocks.push({
        type: 'image',
        data: Buffer.from(attachment.bytes).toString('base64'),
        mimeType,
      } as ContentBlock)
      continue
    }
    blocks.push({
      type: 'text',
      text: `\n\n--- attached file: ${attachment.name} ---\n${Buffer.from(attachment.bytes).toString('utf8')}`,
    })
  }
  return blocks
}

/** One streamed update of the prompted turn (the shapes the CLI consumes). */
export interface CollectedUpdate {
  readonly sessionUpdate: string
  readonly content?: { readonly type: string; readonly text?: string }
  readonly title?: string
  readonly toolCallId?: string
  readonly status?: string
}

/** The assistant's answer: every agent_message_chunk text folded in order. */
export function finalTextOf(updates: readonly CollectedUpdate[]): string {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => (update.content?.type === 'text' ? update.content.text : ''))
    .join('')
}

/** Tool calls merged by id: title from the first sight, status from the last. */
export function toolCallsOf(updates: readonly CollectedUpdate[]): Array<{ title: string; status: string | undefined }> {
  const byId = new Map<string, { title: string; status: string | undefined }>()
  for (const update of updates) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    const id = update.toolCallId ?? ''
    const entry = byId.get(id) ?? { title: '', status: undefined }
    if (update.title !== undefined && entry.title === '') entry.title = update.title
    if (update.status !== undefined) entry.status = update.status
    byId.set(id, entry)
  }
  return [...byId.values()].map((entry) => ({ title: entry.title, status: entry.status }))
}

/** Inputs to the exit-code decision, in priority order. */
export interface RunOutcome {
  /** Error message when the ACP conversation itself failed. */
  readonly error?: string
  readonly timedOut: boolean
  readonly stopReason?: string
  /** At least one permission request was answered with a rejection. */
  readonly permissionDenied: boolean
}

/**
 * 1 error > 2 timeout > 3 cancelled > 4 permission-denied > 0 ok.
 * A timeout cancels the turn, so it wins over the resulting `cancelled`
 * stopReason; a denial does not fail the turn (the agent answers without
 * the tool), so it is the weakest non-zero signal.
 */
export function exitCodeFor(outcome: RunOutcome): number {
  if (outcome.error !== undefined) return EXIT_ERROR
  if (outcome.timedOut) return EXIT_TIMEOUT
  if (outcome.stopReason === 'cancelled') return EXIT_CANCELLED
  if (outcome.permissionDenied) return EXIT_PERMISSION_DENIED
  return EXIT_OK
}

/** The machine-readable result object printed by `--json`. */
export function jsonResultOf(outcome: RunOutcome & { readonly sessionId: string; readonly updates: readonly CollectedUpdate[]; readonly usage?: Record<string, unknown> }): Record<string, unknown> {
  const result: Record<string, unknown> = {
    sessionId: outcome.sessionId,
    stopReason: outcome.stopReason,
    text: finalTextOf(outcome.updates),
    toolCalls: toolCallsOf(outcome.updates),
  }
  if (outcome.usage !== undefined) result.usage = outcome.usage
  if (outcome.error !== undefined) result.error = outcome.error
  return result
}

/** `--model <provider>/<model>` parsing with the CLI's error message. */
export function parseModelSpec(spec: string): { provider: string; model: string } {
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`--model expects <provider>/<model>, got: ${spec}`)
  }
  // First slash splits: namespaced model ids keep their whole id.
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
}
