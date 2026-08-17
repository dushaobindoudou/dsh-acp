import z from '@deepseek-ai/schemastery'

/**
 * Plugin config. M1 has no knobs; the schema exists for forward
 * compatibility and for the loader's config validation.
 */
export const Config = z.object({})
