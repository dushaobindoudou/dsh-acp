/**
 * Plugin config (Schemastery schema — Cordis validates the row's `config:`
 * against this at load time and fills defaults; bad values fail the plugin
 * loudly, per the "无硬编码可调参数 / 配置错误要响亮" conventions).
 *
 * Every field has a default so a user overriding this row in their own
 * profile patch only restates the keys they care about (patch layers replace
 * the whole config value; the schema fills the rest).
 */
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Name reported to ACP clients in `initialize.agentInfo.name`. */
  agentName: string
  /** Pin the model provider for ACP sessions; set together with `model`. */
  provider?: string
  /** Pin the model id for ACP sessions; set together with `provider`. */
  model?: string
  /**
   * Offer allow_always / reject_always in `session/request_permission`.
   * M1 maps "always" grants to one-shot decisions (no remembered rules),
   * so honest deployments can hide them.
   */
  offerAlwaysPermissions: boolean
  /** Flush session persistence after every completed turn. */
  flushOnTurnEnd: boolean
  /**
   * Bearer token required by the HTTP transport (web-mounted mode; the
   * standalone `serve` mode takes it from its own --token flag).
   */
  token?: string
}

export const Config = z.object({
  agentName: z.string().default('dsh').description('name reported to ACP clients in initialize.agentInfo.name'),
  provider: z.string().description('pin the model provider for ACP sessions (set together with model)'),
  model: z.string().description('pin the model id for ACP sessions (set together with provider)'),
  offerAlwaysPermissions: z.boolean().default(true).description('offer allow_always / reject_always permission options'),
  flushOnTurnEnd: z.boolean().default(true).description('flush session persistence after every completed turn'),
  token: z.string().description('bearer token required by the HTTP transport when mounted in a web composition'),
})

/** Resolve the effective model selection: the pin, or the profile default. */
export function modelSelectionOf(
  config: Config,
  defaultSelection: { provider: string; model: string },
): { provider: string; model: string } {
  return config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : defaultSelection
}

/** Loud both-or-neither guard for the provider/model pin. */
export function validateModelPin(config: Config): void {
  const pinned = config.provider !== undefined || config.model !== undefined
  const complete = config.provider !== undefined && config.model !== undefined
  if (pinned && !complete) {
    throw new Error('acp-server config: provider and model must be set together (got '
      + `provider=${JSON.stringify(config.provider)}, model=${JSON.stringify(config.model)})`)
  }
}
