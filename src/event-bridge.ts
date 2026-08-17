/**
 * Event bridge: DSH session events (agent-scoped) -> ACP session/update
 * notifications, plus the tools/execute hook for precise in_progress state.
 *
 * Every listener is registered through the agent's own unpublished setup
 * context, so `dsh-scope` filters events to exactly this agent and Cordis
 * unregisters them when the agent is disposed.
 */
import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AcpSessionEntry } from './table.js'
import { locationsOf, messageChunkId, toolContentOf, toolKindOf, toolTitleOf } from './translate.js'

export type EmitUpdate = (update: SessionUpdate) => void

/** Attach all streaming listeners for one agent. Teardown is scope-owned. */
export function attachEventBridge(agentCtx: Context, entry: AcpSessionEntry, emit: EmitUpdate): void {
  agentCtx.on('session/event', (_session: unknown, event: SessionEvent) => {
    handleSessionEvent(entry, event, emit)
  })

  agentCtx.on('tools/execute', (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
    emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: String(exec.callId),
      status: 'in_progress',
    })
    return next()
  })
}

function handleSessionEvent(entry: AcpSessionEntry, event: SessionEvent, emit: EmitUpdate): void {
  switch (event.type) {
    case 'assistant/chunk': {
      const { turn, step, chunk } = event.data
      if (chunk.type === 'text-delta' && chunk.text.length > 0) {
        emit({
          sessionUpdate: 'agent_message_chunk',
          messageId: messageChunkId(turn, step),
          content: { type: 'text', text: chunk.text },
        })
      } else if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
        emit({
          sessionUpdate: 'agent_thought_chunk',
          messageId: messageChunkId(turn, step),
          content: { type: 'text', text: chunk.text },
        })
      }
      break
    }
    case 'tool/call': {
      const { callId, name, arguments: rawArguments } = event.data
      let parsed: unknown = {}
      try {
        parsed = JSON.parse(rawArguments) as unknown
      } catch {
        parsed = {}
      }
      emit({
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: toolTitleOf(name, parsed),
        kind: toolKindOf(name),
        status: 'pending',
        locations: locationsOf(parsed),
        rawInput: parsed,
      })
      break
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      if (block === undefined || block.type !== 'tool-result') break
      const content = toolContentOf(block.content)
      if (event.data.error !== undefined) {
        const error = event.data.error
        content.push({ type: 'content', content: { type: 'text', text: `error ${error.name}: ${error.code}` } })
      }
      emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: block.toolCallId,
        status: event.data.error !== undefined ? 'failed' : 'completed',
        content,
      })
      break
    }
    case 'todo/write': {
      emit({
        sessionUpdate: 'plan',
        entries: event.data.todos.map((todo) => ({
          content: todo.content,
          priority: 'medium' as const,
          status: todo.status,
        })),
      })
      break
    }
    case 'turn/end': {
      entry.lastTurnEnd = event.data.reason
      break
    }
    default:
      break
  }
}

/** Lazily-resolved connection context (set once AgentApp.connect returns). */
export interface EmitterHost {
  context(): AgentContext | undefined
}

/** Build the fire-and-forget emitter bound to one ACP session. */
export function makeEmitter(sessionId: string, host: EmitterHost, log: (message: string) => void): EmitUpdate {
  return (update: SessionUpdate) => {
    const context = host.context()
    if (context === undefined) return
    void context.notify('session/update', { sessionId, update }).catch((error: unknown) => {
      log(`session/update delivery failed: ${String(error instanceof Error ? error.message : error)}`)
    })
  }
}
