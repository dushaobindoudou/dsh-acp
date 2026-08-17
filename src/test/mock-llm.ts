/**
 * Mock LLM adapter for tests: registers the `mock` provider with a fully
 * deterministic stream script. Loadable as a plugin row
 * (`name: 'dsh-acp/test/mock-llm'`) in a `--patch` overlay.
 *
 * Script (keyed off the assembled request):
 *  - purpose `session-title`       -> short title text
 *  - last message is a tool result -> text quoting the tool output
 *  - last user text has CALL_TOOL   -> one `bash` tool call (`echo acp-e2e-ok`)
 *  - otherwise                     -> one reasoning delta + two text deltas
 */
import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

export const name = 'mock-llm'
export const inject = ['llm']

const MODEL_ID = 'mock-1'

class MockAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Mock' }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: MODEL_ID, name: 'Mock Model' }]
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: 'Mock Model',
      context: { contextWindow: 32768 },
      defaultMaxTokens: 1024,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* scriptFor(options)
  }
}

function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const block = message.content[0]
    if (block === undefined) continue
    if (block.type === 'text') return block.text
    if (block.type === 'tool-result') {
      const text = block.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('')
      return `TOOL_RESULT:${text.slice(0, 200)}`
    }
  }
  return ''
}

async function* scriptFor(options: GenerateOptions): AsyncIterable<StreamChunk> {
  const last = options.messages[options.messages.length - 1]
  const lastBlock = last?.content[0]

  if (options.purpose === 'session-title') {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'mock title' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock title' } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  if (lastBlock !== undefined && lastBlock.type === 'tool-result') {
    const text = lastBlock.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `tool said: ${text.slice(0, 200)}` }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `tool said: ${text.slice(0, 200)}` } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  if (lastUserText(options.messages).includes('CALL_TOOL')) {
    const id = CallId('mock-call-1')
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
  yield { type: 'text-delta', index: 1, text: 'Second chunk.' }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello from dsh-acp mock. Second chunk.' } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export function apply(ctx: Context): void {
  const dispose = ctx.llm.registerAdapter(['mock'], new MockAdapter())
  ctx.effect(() => dispose)
}

export default { name, inject, apply }
