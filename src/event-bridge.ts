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
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// `todo/write` is declared by the tool-todo plugin as a SessionEventMap
// augmentation (it moved out of the core map in dsh 0.1.2); the type-only
// import is what pulls that declaration into this compilation.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { AcpSessionEntry } from './table.js'
import { locationsOf, messageChunkId, toolContentOf, toolKindOf, toolTitleOf } from './translate.js'
import { notifyWatchers } from './watch.js'

export type EmitUpdate = (update: SessionUpdate) => void

/** Attach all streaming listeners for one agent. Teardown is scope-owned. */
export function attachEventBridge(agentCtx: Context, entry: AcpSessionEntry, emit: EmitUpdate): void {
  agentCtx.on('session/event', (session: { id?: string }, event: SessionEvent) => {
    handleSessionEvent(entry, event, emit)
    // Watchers (dsh/sessions/watch) observe the same translated frames.
    if (session.id !== undefined) notifyWatchers(session.id, event)
  })

  // dsh 0.1.5 removed the `assistant/chunk` session event: token-level
  // streaming now travels only on this process-local publication (the durable
  // `assistant/message` event embeds the compacted stream instead). Chunk
  // frames carry no turn/step, so track the position from the latest `start`
  // frame of each attempt and reuse the 0.1.2 messageId scheme.
  const streamPos = new Map<string, { turn: number; step: number }>()
  agentCtx.on('agent/assistant-stream', (payload: { frame: AssistantStreamFrame }) => {
    const frame = payload.frame
    if (frame.type === 'start') {
      streamPos.set(String(frame.attemptId), { turn: frame.turn, step: frame.step })
      return
    }
    if (frame.type === 'end') {
      streamPos.delete(String(frame.attemptId))
      return
    }
    const pos = streamPos.get(String(frame.attemptId))
    if (pos === undefined) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta' && chunk.text.length > 0) {
      emit({
        sessionUpdate: 'agent_message_chunk',
        messageId: messageChunkId(pos.turn, pos.step),
        content: { type: 'text', text: chunk.text },
      })
    } else if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
      emit({
        sessionUpdate: 'agent_thought_chunk',
        messageId: messageChunkId(pos.turn, pos.step),
        content: { type: 'text', text: chunk.text },
      })
    }
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

/**
 * Pure event -> ACP update translation (first update only). Kept for the
 * single-update API shape; watch delivery uses {@link translateSessionEventAll}.
 */
export function translateSessionEvent(event: SessionEvent): SessionUpdate | null {
  return translateSessionEventAll(event)[0] ?? null
}

/**
 * Pure event -> ACP updates translation, expanding each session event into
 * every ACP update it represents. Exported so the plugin-fiber-level listener
 * can serve watch requests for sessions created outside this plugin.
 */
export function translateSessionEventAll(event: SessionEvent): SessionUpdate[] {
  switch (event.type) {
    case 'assistant/message': {
      // Whole-segment expansion for watch/replay delivery. The live agent
      // path streams deltas via `agent/assistant-stream` and skips this event
      // in handleSessionEvent, so nothing double-emits.
      const updates: SessionUpdate[] = []
      for (const block of event.data.message.content) {
        if ((block.type === 'text' || block.type === 'reasoning') && block.text.length > 0) {
          updates.push({
            sessionUpdate: block.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
            messageId: event.data.message.id,
            content: { type: 'text', text: block.text },
          })
        }
      }
      return updates
    }
    case 'tool/call': {
      const { callId, name, arguments: rawArguments } = event.data
      let parsed: unknown = {}
      try {
        parsed = JSON.parse(rawArguments) as unknown
      } catch {
        parsed = {}
      }
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          title: toolTitleOf(name, parsed),
          kind: toolKindOf(name),
          status: 'pending',
          locations: locationsOf(parsed),
          rawInput: parsed,
        },
      ]
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      if (block === undefined || block.type !== 'tool-result') return []
      const content = toolContentOf(block.content)
      if (event.data.error !== undefined) {
        const error = event.data.error
        content.push({ type: 'content', content: { type: 'text', text: `error ${error.name}: ${error.code}` } })
      }
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: block.toolCallId,
          status: event.data.error !== undefined ? 'failed' : 'completed',
          content,
        },
      ]
    }
    case 'todo/write': {
      return [
        {
          sessionUpdate: 'plan',
          entries: event.data.todos.map((todo) => ({
            content: todo.content,
            priority: 'medium' as const,
            status: todo.status,
          })),
        },
      ]
    }
    default:
      return []
  }
}

function handleSessionEvent(entry: AcpSessionEntry, event: SessionEvent, emit: EmitUpdate): void {
  if (event.type === 'turn/end') {
    entry.lastTurnEnd = event.data.reason
    return
  }
  if (event.type === 'assistant/message') {
    // 0.1.5: the committed message duplicates content the live
    // `agent/assistant-stream` deltas already delivered; translating it here
    // would double-emit. Watch/replay paths expand it instead (see
    // translateSessionEventAll).
    return
  }
  const update = translateSessionEvent(event)
  if (update !== null) emit(update)
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
