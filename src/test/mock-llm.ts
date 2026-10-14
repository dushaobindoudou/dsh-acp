/**
 * Mock LLM adapter for tests: registers the `mock` provider with a fully
 * deterministic stream script. Loadable as a plugin row
 * (`name: 'dsh-acp/test/mock-llm'`) in a `--patch` overlay.
 *
 * Script (keyed off the assembled request):
 *  - purpose `session-title`       -> short title text
 *  - last message is a tool result -> text quoting the tool output
 *  - last user text has CALL_TOOL   -> one `bash` tool call (`echo acp-e2e-ok`)
 *  - last user text has ASK_USER    -> one `ask_user_question` call (question bridge)
 *  - otherwise                     -> one reasoning delta + two text deltas
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

export const name = 'mock-llm'
export const inject = ['llm']

const MODEL_ID = 'mock-1'
/** A second model that declares reasoning efforts, for set_config_option. */
const REASONING_MODEL_ID = 'mock-2'
const EFFORTS = [
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('high'), name: 'High' },
] as const

class MockAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Mock' }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [
      { provider, id: MODEL_ID, name: 'Mock Model' },
      { provider, id: REASONING_MODEL_ID, name: 'Mock Reasoner' },
    ]
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model === REASONING_MODEL_ID ? 'Mock Reasoner' : 'Mock Model',
      context: { contextWindow: 32768 },
      defaultMaxTokens: 1024,
      // The e2e exercises the image-prompt path; a real image-capable
      // provider declares the modality, so the honest capability gate
      // advertises it (mirrors official dsh-acp behavior).
      inputModalities: ['text', 'image'],
      // Only the reasoning model exposes efforts: the e2e asserts that the
      // plain model route REFUSES a reasoning_effort override loudly.
      ...(model === REASONING_MODEL_ID ? { reasoning: { efforts: EFFORTS, defaultEffort: ReasoningEffortId('low') } } : {}),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* scriptFor(options)
  }
}

function lastUserText(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    // dsh 0.2: tool results are first-class `role: 'tool'` messages instead
    // of a `tool-result` block inside a user message.
    if (message.role === 'tool') return `TOOL_RESULT:${textOf(message.content).slice(0, 200)}`
    if (message.role !== 'user') continue
    // dsh 0.2 appends synthetic user-role context (runtime snapshots, file
    // notices) after the human prompt; script on what the human typed.
    if (message.source !== undefined && message.source.kind !== 'user') continue
    const block = message.content[0]
    if (block === undefined) continue
    if (block.type === 'text') return block.text
  }
  return ''
}

function textOf(blocks: RequestMessage['content']): string {
  return blocks
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
}

/** DSH 0.2 carries tool results as user messages with tool-result blocks. */
function toolResultTextOf(message: RequestMessage): string | undefined {
  const results = (message.content as readonly unknown[])
    .filter((block): block is { type: 'tool-result'; content?: readonly { type: string; text?: string }[] } =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'tool-result')
  if (results.length === 0) return undefined
  return results.flatMap((result) => result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

async function* scriptFor(options: GenerateOptions): AsyncIterable<StreamChunk> {
  const last = options.messages[options.messages.length - 1]

  if (options.purpose === 'session-title') {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'mock title' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock title' } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  if (last !== undefined && (last.role === 'tool' || toolResultTextOf(last) !== undefined)) {
    const text = toolResultTextOf(last) ?? textOf(last.content)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `tool said: ${text.slice(0, 200)}` }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `tool said: ${text.slice(0, 200)}` } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  // ASK_USER exercises the question bridge: one single-select question
  // through dsh's ask_user_question tool (web compositions mount it).
  if (lastUserText(options.messages).includes('ASK_USER')) {
    const id = ToolCallId('mock-ask-1')
    const name = 'ask_user_question'
    const args = JSON.stringify({
      questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'red (Recommended)' }, { label: 'blue' }] }],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }

  if (lastUserText(options.messages).includes('CALL_TOOL')) {
    const id = ToolCallId('mock-call-1')
    const name = 'bash'
    const args = JSON.stringify({ command: 'echo acp-e2e-ok', description: 'e2e echo' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }

  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: 'mock thought' }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'mock thought' } }
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: 'Hello from dsh-acp mock. ' }
  // SLOW parks the stream mid-turn so the e2e can cancel deterministically:
  // the prompt is already in flight when the client sends its cancel. Any
  // user message matches — a durable model-switch notice can be the LAST
  // user message, which must not hide the user's own SLOW request.
  if (anyUserText(options.messages, 'SLOW')) {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  yield { type: 'text-delta', index: 1, text: 'Second chunk.' }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from dsh-acp mock. Second chunk.' } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function anyUserText(messages: readonly RequestMessage[], needle: string): boolean {
  return messages.some((message) =>
    message.role === 'user' && message.content.some((block) => block.type === 'text' && block.text.includes(needle)),
  )
}

export function apply(ctx: Context): void {
  const dispose = ctx.llm.registerAdapter(['mock'], new MockAdapter())
  ctx.effect(() => dispose)
}

export default { name, inject, apply }
