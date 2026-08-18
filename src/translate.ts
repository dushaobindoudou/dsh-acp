/**
 * Pure translations between DSH runtime values and ACP v1 wire values.
 * No Cordis imports here — every function is trivially unit-testable.
 */
import type { ContentBlock as AcpContentBlock, StopReason, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/** Map a DSH turn-end reason to the ACP prompt stopReason. */
export function stopReasonOf(reason: TurnEndReason | undefined): StopReason {
  if (reason === undefined) return 'end_turn'
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'aborted':
      return 'cancelled'
    case 'max-tokens':
      return 'max_tokens'
    case 'error':
      // The failure text reached the client as message chunks; ACP's
      // `refusal` is reserved for model refusals, so an infrastructure
      // error still ends the turn normally.
      return 'end_turn'
    case 'blocked':
    case 'interrupted':
      return 'cancelled'
    default:
      return 'end_turn'
  }
}

/** DSH tool name → ACP ToolKind (icon/UX hint only). */
export function toolKindOf(name: string): ToolKind {
  if (name === 'bash' || name === 'pwsh') return 'execute'
  if (name === 'read') return 'read'
  if (name === 'edit' || name === 'write' || name === 'str_replace_editor') return 'edit'
  if (name === 'glob' || name === 'grep') return 'search'
  if (name === 'web_search') return 'fetch'
  if (name === 'subagent' || name === 'workflow' || name === 'ralph' || name === 'todo_write') return 'think'
  return 'other'
}

/** Human-readable title for a tool call, derived from its parsed arguments. */
export function toolTitleOf(name: string, args: unknown): string {
  const record = (args !== null && typeof args === 'object') ? args as Record<string, unknown> : {}
  const first = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  switch (name) {
    case 'bash':
    case 'pwsh': {
      const command = first('command') ?? first('script')
      if (command !== undefined) return command.split('\n')[0]!.slice(0, 80)
      break
    }
    case 'read': {
      const path = first('file_path') ?? first('path')
      if (path !== undefined) return path
      break
    }
    case 'edit':
    case 'write':
    case 'str_replace_editor': {
      const path = first('file_path') ?? first('path')
      if (path !== undefined) return `${name} ${path}`
      break
    }
    case 'glob':
    case 'grep': {
      const pattern = first('pattern') ?? first('query')
      if (pattern !== undefined) return `${name} ${pattern}`.slice(0, 80)
      break
    }
    case 'subagent': {
      const description = first('description')
      if (description !== undefined) return description.slice(0, 80)
      break
    }
    default:
      break
  }
  return name
}

/** Extract follow-along locations from parsed tool arguments. */
export function locationsOf(args: unknown): ToolCallLocation[] {
  const record = (args !== null && typeof args === 'object') ? args as Record<string, unknown> : {}
  const locations: ToolCallLocation[] = []
  for (const key of ['file_path', 'path', 'workdir']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      locations.push({ path: value })
      break
    }
  }
  return locations
}

/** DSH content blocks → ACP tool-call content entries. */
export function toolContentOf(blocks: readonly ContentBlock[]): ToolCallContent[] {
  const out: ToolCallContent[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) out.push({ type: 'content', content: { type: 'text', text: block.text } })
        break
      case 'reasoning':
        break
      case 'image':
        // ImageAttachmentRef bytes live in the attachment store, not on the
        // block; M1 renders a placeholder, M3 resolves bytes via ctx.attachments.
        out.push({ type: 'content', content: { type: 'text', text: '[image output]' } })
        break
      default:
        break
    }
  }
  return out
}

/** ACP prompt content blocks → DSH model-facing content blocks (M1: text + links). */
export function promptToContent(prompt: readonly AcpContentBlock[]): ContentBlock[] {
  const parts: string[] = []
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'resource_link':
        parts.push(`[${block.name ?? 'resource'}](${block.uri})`)
        break
      case 'resource': {
        const text = 'text' in block.resource ? block.resource.text : undefined
        if (typeof text === 'string' && text.length > 0) parts.push(text)
        else parts.push(`[resource] ${block.resource.uri}`)
        break
      }
      case 'image':
        // Handled by resolvePromptContent (needs the async attachments
        // service); the sync text fold only sees the fallback marker.
        parts.push('[image]')
        break
      case 'audio':
        parts.push('[audio attachment received but unsupported in M1]')
        break
      default:
        break
    }
  }
  return [{ type: 'text', text: parts.join('\n') }]
}

/** Is this stream chunk worth forwarding as an ACP message/thought chunk? */
export function chunkKind(chunk: StreamChunk): 'message' | 'thought' | undefined {
  if (chunk.type === 'text-delta' && chunk.text.length > 0) return 'message'
  if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) return 'thought'
  return undefined
}

/** Stable ACP messageId for one DSH (turn, step) assistant stream. */
export function messageChunkId(turn: number, step: number): string {
  return `m-${turn}-${step}`
}


/** An image block extracted from a prompt, pending attachment storage. */
export interface PromptImage {
  readonly kind: 'image'
  readonly data: string
  readonly mimeType: string
}

/** Whether this ACP prompt carries at least one image block. */
export function promptHasImage(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some((block) => block.type === 'image')
}

/** Extract every image block (base64 + mimeType) from a prompt. */
export function promptImages(prompt: readonly AcpContentBlock[]): PromptImage[] {
  return prompt.flatMap((block) =>
    block.type === 'image' ? [{ kind: 'image' as const, data: block.data, mimeType: block.mimeType }] : [],
  )
}

/** dsh image media types accepted by the version-one attachment path. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
