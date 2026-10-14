/**
 * Pure logic of the host-control subcommands (`call`, `stream`, `catalog`,
 * `rpc`) and of answering agent questions from a terminal. No process, no
 * SDK runtime — unit-tested like run-core.ts.
 */

/**
 * Parse a JSON argument given on the command line. Empty means `{}`; the
 * error names the subcommand's expectation instead of a bare SyntaxError.
 */
export function parseJsonArg(text: string | undefined, what: string): Record<string, unknown> {
  if (text === undefined || text.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${what} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}`)
  return value as Record<string, unknown>
}

/** Reject limits that would silently disable cancellation or never be reached. */
export function positiveNumberArg(text: string, flag: string, integer = false): number {
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${flag} expects a positive ${integer ? 'integer' : 'finite number'}, got: ${text}`)
  }
  return value
}

/** A catalog entry as `dsh/remote/catalog` returns it. */
export interface CatalogMethodLike {
  readonly endpoint: string
  readonly stream: boolean
  readonly params: ReadonlyArray<{ readonly name: string; readonly optional: boolean; readonly lookup?: string }>
  readonly summary?: string
}

/**
 * One line per method: `ns/method(args) [stream]  — summary`. Lookup
 * parameters are tagged with what they resolve (`agentId<agent>`: a live
 * session id).
 */
export function formatCatalog(methods: readonly CatalogMethodLike[]): string {
  const rows = methods.map((method) => {
    const params = method.params
      .map((param) => `${param.name}${param.optional ? '?' : ''}${param.lookup !== undefined ? `<${param.lookup}>` : ''}`)
      .join(', ')
    return { head: `${method.endpoint}(${params})${method.stream ? ' [stream]' : ''}`, summary: method.summary }
  })
  const width = Math.min(72, Math.max(0, ...rows.map((row) => row.head.length)))
  return rows
    .map((row) => (row.summary !== undefined ? `${row.head.padEnd(width)}  ${firstSentence(row.summary)}` : row.head))
    .join('\n')
}

function firstSentence(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

/** A question as it arrives in an `elicitation/create` form schema property. */
export interface FormQuestion {
  readonly id: string
  readonly title: string
  readonly description?: string
  /** Offered choices (`oneOf` / `items.anyOf` consts); empty for free text. */
  readonly choices: readonly string[]
  readonly multi: boolean
}

/**
 * Read the questions out of a form-mode elicitation schema (the server's
 * question bridge emits one property per question, plus `<id>__other`
 * free-text companions that this reader folds back into their question).
 */
export function questionsOfForm(schema: { properties?: Record<string, unknown> } | undefined): FormQuestion[] {
  const properties = schema?.properties ?? {}
  const out: FormQuestion[] = []
  for (const [id, raw] of Object.entries(properties)) {
    if (id.endsWith('__other')) continue
    const property = (raw ?? {}) as { title?: string; description?: string; type?: string; oneOf?: Array<{ const?: string }>; enum?: string[]; items?: { anyOf?: Array<{ const?: string }>; enum?: string[] } }
    const multi = property.type === 'array'
    const choices = multi
      ? (property.items?.anyOf?.map((option) => option.const) ?? property.items?.enum ?? [])
      : (property.oneOf?.map((option) => option.const) ?? property.enum ?? [])
    out.push({
      id,
      title: property.title ?? id,
      ...property.description !== undefined ? { description: property.description } : {},
      choices: choices.filter((choice): choice is string => typeof choice === 'string'),
      multi,
    })
  }
  return out
}

/**
 * Fold one typed reply into form content: `1` / `1,3` pick choices by
 * number, an empty line picks the first (recommended) choice, anything else
 * is free text (the question's `__other` field, or its value for a
 * free-text question).
 */
export function replyToContent(question: FormQuestion, line: string): Record<string, unknown> {
  const reply = line.trim()
  if (question.choices.length === 0) return reply.length > 0 ? { [question.id]: reply } : {}
  if (reply === '') {
    const first = question.choices[0]!
    return { [question.id]: question.multi ? [first] : first }
  }
  const numbers = reply.split(/[\s,]+/).map(Number)
  if (numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= question.choices.length)) {
    const picked = numbers.map((value) => question.choices[value - 1]!)
    return { [question.id]: question.multi ? picked : picked[0] }
  }
  return { [`${question.id}__other`]: reply }
}

/** The unattended form answer: every choice question's first option. */
export function autoFormContent(questions: readonly FormQuestion[]): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const question of questions) {
    const first = question.choices[0]
    if (first !== undefined) content[question.id] = question.multi ? [first] : first
  }
  return content
}
