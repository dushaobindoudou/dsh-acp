/**
 * Pure builders and validators for ACP session configOptions
 * (`session/set_config_option`). No Cordis imports — every function is
 * trivially unit-testable, mirroring translate.ts.
 *
 * dsh exposes two per-session knobs today:
 *  - `model` (category "model"): a select over every registered provider's
 *    advertised models, valued `<provider>/<model>`;
 *  - `reasoning_effort` (category "thought_level"): a select over the CURRENT
 *    model route's adapter-declared efforts, present only when the route
 *    declares any.
 */
import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'

/** Config option ids as they appear on the wire. */
export const MODEL_CONFIG_ID = 'model'
export const REASONING_CONFIG_ID = 'reasoning_effort'

/** The synthetic effort value that clears an inherited effort. */
export const DEFAULT_EFFORT_VALUE = 'default'

/** The live per-session selection (dsh-agent ModelSelection, structurally). */
export interface SelectionValue {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One provider's advertised models (already detached from the llm service). */
export interface ProviderCatalog {
  readonly id: string
  readonly name: string
  readonly models: ReadonlyArray<{ id: string; name: string; description?: string }>
}

/** The reasoning slice of one resolved model route. */
export interface ReasoningInfo {
  readonly efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
  readonly defaultEffort?: string
}

/** `<provider>/<model>` — the wire value of the model select. */
export function modelValueOf(selection: SelectionValue): string {
  return `${selection.provider}/${selection.model}`
}

/**
 * Parse a `<provider>/<model>` select value; `undefined` when malformed.
 * Splits at the FIRST slash, so namespaced model ids (`gateway/org/model`)
 * keep their whole id; provider route keys never contain slashes.
 */
export function parseModelValue(value: string): { provider: string; model: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

function select(value: string, name: string, description?: string): SessionConfigSelectOption {
  return description === undefined ? { value, name } : { value, name, description }
}

/**
 * The model select. Groups mirror the provider catalog; the current selection
 * is always present even when every catalog read failed (flat single-option
 * fallback), so the client can always render the live value.
 */
export function buildModelOption(
  selection: SelectionValue,
  catalog: ReadonlyArray<ProviderCatalog>,
): SessionConfigOption {
  const currentValue = modelValueOf(selection)
  const groups = catalog
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      group: provider.id,
      name: provider.name,
      options: provider.models.map((model) =>
        select(modelValueOf({ provider: provider.id, model: model.id }), model.name, model.description),
      ),
    }))
  if (groups.length === 0) {
    return {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [select(currentValue, currentValue)],
    }
  }
  const hasCurrent = groups.some((group) => group.options.some((option) => option.value === currentValue))
  if (!hasCurrent) {
    groups.push({
      group: '_current',
      name: 'Current',
      options: [select(currentValue, currentValue)],
    })
  }
  return {
    id: MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: groups,
  }
}

/**
 * The reasoning-effort select for the CURRENT model route, or `undefined`
 * when the route declares no efforts (the honest absence: a client never
 * sees a selector that cannot be honored).
 */
export function buildReasoningOption(
  selection: SelectionValue,
  reasoning: ReasoningInfo | undefined,
): SessionConfigOption | undefined {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  const options: SessionConfigSelectOption[] = [
    select(DEFAULT_EFFORT_VALUE, 'Default', "the model's provider default behavior"),
    ...efforts.map((effort) => select(effort.id, effort.name, effort.description)),
  ]
  const rawCurrent = selection.reasoningEffort ?? reasoning?.defaultEffort ?? DEFAULT_EFFORT_VALUE
  const currentValue = options.some((option) => option.value === rawCurrent) ? rawCurrent : DEFAULT_EFFORT_VALUE
  return {
    id: REASONING_CONFIG_ID,
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options,
  }
}

/** A precise rejection message for a model select value, or `undefined`. */
export function validateModelChoice(
  catalog: ReadonlyArray<ProviderCatalog>,
  parsed: { provider: string; model: string },
): string | undefined {
  const provider = catalog.find((entry) => entry.id === parsed.provider)
  if (provider === undefined) {
    const known = catalog.map((entry) => entry.id).join(', ')
    return `unknown provider: ${parsed.provider}${known.length > 0 ? ` (registered: ${known})` : ''}`
  }
  if (provider.models.length === 0) return undefined // catalog read failed earlier; let the route validate at call time
  if (!provider.models.some((model) => model.id === parsed.model)) {
    return `unknown model: ${parsed.model} for provider ${parsed.provider} (advertised: ${provider.models.map((model) => model.id).join(', ')})`
  }
  return undefined
}

/** A precise rejection message for an effort select value, or `undefined`. */
export function validateEffortChoice(reasoning: ReasoningInfo, value: string): string | undefined {
  if (value === DEFAULT_EFFORT_VALUE) return undefined
  const ids = reasoning.efforts.map((effort) => effort.id)
  if (ids.includes(value)) return undefined
  return `unknown reasoning effort: ${value} (accepted: ${DEFAULT_EFFORT_VALUE}, ${ids.join(', ')})`
}
