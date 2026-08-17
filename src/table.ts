/**
 * The ACP session table: one entry per ACP-driven agent.
 * Everything here is owned by the acp-server plugin fiber.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentContext } from '@agentclientprotocol/sdk'

/** Live per-session state the bridges mutate while streaming. */
export interface AcpSessionEntry {
  readonly sessionId: string
  agent: Agent
  /** Consumer capability from `ctx.agents.create()`; tears the agent down. */
  dispose: () => Promise<void>
  readonly cwd: string
  /** Reason of the most recent `turn/end` observed by the event bridge. */
  lastTurnEnd: TurnEndReason | undefined
  /** The ACP client (connection) that created this session; its notification channel. */
  client: AgentContext | undefined
  /** Guard: one in-flight session/prompt at a time. */
  prompting: boolean
}

export class AcpSessionTable {
  private readonly entries = new Map<string, AcpSessionEntry>()

  add(entry: AcpSessionEntry): void {
    this.entries.set(entry.sessionId, entry)
  }

  get(sessionId: string): AcpSessionEntry | undefined {
    return this.entries.get(sessionId)
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  list(): AcpSessionEntry[] {
    return [...this.entries.values()]
  }

  async disposeAll(): Promise<void> {
    const pending = this.list().map(async (entry) => {
      try {
        await entry.dispose()
      } catch {
        // Dispose is best-effort during teardown; the loop's own drain owns
        // the authoritative cleanup.
      }
    })
    this.entries.clear()
    await Promise.all(pending)
  }
}
