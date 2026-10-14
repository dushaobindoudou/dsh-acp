/**
 * Pure mappings between dsh user questions (`ask_user_question`, plan
 * review) and ACP: the form-mode `elicitation/create` request for clients
 * that declare `clientCapabilities.elicitation.form`, a
 * `session/request_permission` fallback for one single-select question on
 * clients that do not, and the unattended answer an orchestrator's
 * `auto` policy gives. No Cordis or SDK runtime imports — unit-tested.
 */

/** dsh `AskUserQuestionItem` (structural copy; the seam lives in dsh-user-questions). */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly multiSelect?: boolean
}

/** dsh `AskUserQuestionAnswer`: `selected` empty and no `custom` = skipped. */
export interface QuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** Free-text companion field of an option question in the elicitation form. */
export const OTHER_SUFFIX = '__other'

/** The ACP form-mode elicitation for a question batch (session-scoped). */
export function elicitationOf(sessionId: string, toolCallId: string | undefined, questions: readonly QuestionItem[]) {
  const properties: Record<string, unknown> = {}
  for (const question of questions) {
    const title = question.header ?? question.question
    const description = question.header !== undefined
      ? joinLines(question.question, question.detail)
      : question.detail
    const options = question.options ?? []
    if (options.length === 0) {
      properties[question.id] = { type: 'string', title, ...description !== undefined ? { description } : {} }
      continue
    }
    const choices = options.map((option) => ({
      const: option.label,
      title: option.label,
      ...option.description !== undefined ? { description: option.description } : {},
    }))
    properties[question.id] = question.multiSelect === true
      ? { type: 'array', title, ...description !== undefined ? { description } : {}, items: { anyOf: choices } }
      : { type: 'string', title, ...description !== undefined ? { description } : {}, oneOf: choices }
    properties[`${question.id}${OTHER_SUFFIX}`] = { type: 'string', title: `${title} (other, free text)` }
  }
  return {
    mode: 'form' as const,
    sessionId,
    ...toolCallId !== undefined ? { toolCallId } : {},
    message: questions.length === 1 && questions[0] !== undefined
      ? joinLines(questions[0].question, questions[0].detail) ?? questions[0].question
      : `The agent needs your input on ${questions.length} questions.`,
    requestedSchema: { type: 'object' as const, properties, required: [] as string[] },
  }
}

/**
 * Fold an accepted elicitation's content back into dsh answers. Option
 * labels outside the offered set are dropped (a client cannot widen the
 * choice); an absent field is a skipped question.
 */
export function answersFromElicitation(questions: readonly QuestionItem[], content: Record<string, unknown> | null | undefined): QuestionAnswer {
  const values = content ?? {}
  return {
    answers: questions.map((question) => {
      const options = question.options ?? []
      const raw = values[question.id]
      if (options.length === 0) {
        const text = typeof raw === 'string' ? raw.trim() : ''
        return text.length > 0 ? { id: question.id, selected: [], custom: text } : { id: question.id, selected: [] }
      }
      const labels = new Set(options.map((option) => option.label))
      const picked = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .filter((value): value is string => typeof value === 'string' && labels.has(value))
      const selected = question.multiSelect === true ? picked : picked.slice(0, 1)
      const other = values[`${question.id}${OTHER_SUFFIX}`]
      const custom = typeof other === 'string' && other.trim().length > 0 ? other.trim() : undefined
      return custom !== undefined ? { id: question.id, selected, custom } : { id: question.id, selected }
    }),
  }
}

/** Option id of the "skip" choice in the permission-prompt fallback. */
export const SKIP_OPTION_ID = 'question-skip'

/**
 * The `session/request_permission` fallback: only for exactly one
 * single-select question with options — anything richer cannot be expressed
 * as a button row and falls through to the next answerer.
 */
export function permissionFallbackOf(questions: readonly QuestionItem[]): Array<{ optionId: string; name: string; kind: 'allow_once' | 'reject_once' }> | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0]!
  const options = question.options ?? []
  if (options.length === 0 || question.multiSelect === true) return undefined
  return [
    ...options.map((option, index) => ({ optionId: `question-${index}`, name: option.label, kind: 'allow_once' as const })),
    { optionId: SKIP_OPTION_ID, name: 'Skip', kind: 'reject_once' as const },
  ]
}

/** Fold the chosen fallback option back into a dsh answer. */
export function answersFromPermission(questions: readonly QuestionItem[], optionId: string): QuestionAnswer {
  const question = questions[0]!
  const match = /^question-(\d+)$/.exec(optionId)
  const option = match !== null ? question.options?.[Number(match[1])] : undefined
  return { answers: [{ id: question.id, selected: option !== undefined ? [option.label] : [] }] }
}

/**
 * The unattended answer (`permissionPolicy: auto` with no client to ask):
 * the FIRST option of every option question — the tool contract puts the
 * recommended choice first — and a skip for free-text questions.
 */
export function autoAnswerOf(questions: readonly QuestionItem[]): QuestionAnswer {
  return {
    answers: questions.map((question) => {
      const first = question.options?.[0]
      return { id: question.id, selected: first !== undefined ? [first.label] : [] }
    }),
  }
}

function joinLines(first: string | undefined, second: string | undefined): string | undefined {
  const parts = [first, second].filter((part): part is string => part !== undefined && part.length > 0)
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
