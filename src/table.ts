/**
 * The ACP session table: one entry per ACP-driven agent.
 * Everything here is owned by the acp-server plugin fiber.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentContext } from '@agentclientprotocol/sdk'
import type { UsageTotals } from './translate.js'

/** Live per-session state the bridges mutate while streaming. */
export interface AcpSessionEntry {
  readonly sessionId: string
  agent: Agent
  /** Consumer capability from `ctx.agents.create()`; tears the agent down. */
  dispose: () => Promise<void>
  /** Working directory; resume refills it from the persisted header. */
  cwd: string
  /** Reason of the most recent `turn/end` observed by the event bridge. */
  lastTurnEnd: TurnEndReason | undefined
  /** The ACP client (connection) that created this session; its notification channel. */
  client: AgentContext | undefined
  /** Last advertised ACP mode id, for change detection. */
  modeId?: 'default' | 'plan'
  /** Guard: one in-flight session/prompt at a time. */
  prompting: boolean
  /**
   * The mutable per-session model selection owned by installModelSelection.
   * `session/set_config_option` rewrites `current` live — the NEXT step
   * (not the current one) picks it up, per the dsh model-selection contract.
   */
  modelRef: ModelSelectionRef
  /** Token totals accumulated for the in-flight turn (reset each prompt). */
  turnUsage: UsageTotals | undefined
  /** Context window of the current model route; re-resolved after a model switch. */
  contextWindow: number | undefined
  /**
   * The agent is live but owned elsewhere (the web GUI, another plugin, a
   * prior process surface): this entry only ATTACHED its bridges. Closing or
   * releasing it detaches them and never disposes the agent.
   */
  adopted: boolean
  /**
   * How this session's permission requests and user questions are answered:
   * `ask` routes them to the bound client (falling through to the next dsh
   * answerer when no client is bound), `auto` grants once / picks the first
   * (recommended) option without asking, `deny` rejects / skips. An
   * orchestrator sets `auto` before detaching a long-running task.
   */
  permissionPolicy: PermissionPolicy
  /** Listener/selection disposers of an adopted entry (owned entries unwind with their scope). */
  detach: Array<() => unknown>
  /** Whether `modelRef` is installed on the agent (always for owned entries; on demand for adopted ones). */
  modelSelectionInstalled: boolean
}

export type PermissionPolicy = 'ask' | 'auto' | 'deny'

export function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  return value === 'ask' || value === 'auto' || value === 'deny'
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
