/**
 * session/set_config_option building blocks: model-select construction over
 * a provider catalog (with degraded catalogs still rendering the live
 * value), reasoning-effort selects that appear only when the route declares
 * efforts, and the loud validation of client-provided values.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MODEL_CONFIG_ID,
  REASONING_CONFIG_ID,
  DEFAULT_EFFORT_VALUE,
  buildModelOption,
  buildReasoningOption,
  modelValueOf,
  parseModelValue,
  validateEffortChoice,
  validateModelChoice,
} from '../../lib/config-options.js'

const CATALOG = [
  { id: 'mock', name: 'Mock', models: [{ id: 'mock-1', name: 'Mock Model' }, { id: 'mock-2', name: 'Mock Reasoner' }] },
  { id: 'other', name: 'Other', models: [{ id: 'o-1', name: 'O1' }] },
]

test('modelValueOf / parseModelValue round-trip <provider>/<model>', () => {
  assert.equal(modelValueOf({ provider: 'mock', model: 'mock-1' }), 'mock/mock-1')
  assert.deepEqual(parseModelValue('mock/mock-1'), { provider: 'mock', model: 'mock-1' })
  // First slash splits; the model id may contain slashes, the provider may not.
  assert.deepEqual(parseModelValue('gateway/org/big/model'), { provider: 'gateway', model: 'org/big/model' })
  assert.equal(parseModelValue('/model'), undefined)
  assert.equal(parseModelValue('provider/'), undefined)
  assert.equal(parseModelValue('no-slash'), undefined)
})

test('buildModelOption groups the catalog and reports the live selection', () => {
  const option = buildModelOption({ provider: 'mock', model: 'mock-1' }, CATALOG)
  assert.equal(option.id, MODEL_CONFIG_ID)
  assert.equal(option.category, 'model')
  assert.equal(option.type, 'select')
  assert.equal(option.currentValue, 'mock/mock-1')
  const groups = option.options
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].options.map((o) => o.value), ['mock/mock-1', 'mock/mock-2'])
  assert.equal(groups[0].options[1].name, 'Mock Reasoner')
})

test('buildModelOption keeps the live value visible when the catalog is empty', () => {
  const option = buildModelOption({ provider: 'p', model: 'm' }, [])
  assert.deepEqual(option.options, [{ value: 'p/m', name: 'p/m' }])
  assert.equal(option.currentValue, 'p/m')
})

test('buildModelOption appends a Current group when the selection is unlisted', () => {
  const option = buildModelOption({ provider: 'gone', model: 'gone-1' }, CATALOG)
  const values = option.options.flatMap((group) => group.options.map((o) => o.value))
  assert.ok(values.includes('gone/gone-1'), 'the live selection stays selectable')
  assert.equal(option.currentValue, 'gone/gone-1')
})

test('buildReasoningOption lists efforts plus the synthetic default', () => {
  const reasoning = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
  const option = buildReasoningOption({ provider: 'mock', model: 'mock-2' }, reasoning)
  assert.equal(option.id, REASONING_CONFIG_ID)
  assert.equal(option.category, 'thought_level')
  // An unset effort reports the adapter's materialized default — the honest
  // current value the model will actually run at.
  assert.equal(option.currentValue, 'low')
  assert.deepEqual(option.options.map((o) => o.value), ['default', 'low', 'high'])

  const explicit = buildReasoningOption({ provider: 'mock', model: 'mock-2', reasoningEffort: 'high' }, reasoning)
  assert.equal(explicit.currentValue, 'high')
})

test('buildReasoningOption is absent when the route declares no efforts', () => {
  assert.equal(buildReasoningOption({ provider: 'mock', model: 'mock-1' }, undefined), undefined)
  assert.equal(buildReasoningOption({ provider: 'mock', model: 'mock-1' }, { efforts: [] }), undefined)
})

test('buildReasoningOption falls back to default for an unknown current effort', () => {
  const option = buildReasoningOption(
    { provider: 'mock', model: 'mock-2', reasoningEffort: 'turbo' },
    { efforts: [{ id: 'low', name: 'Low' }] },
  )
  assert.equal(option.currentValue, 'default')
})

test('validateModelChoice rejects unknown providers and models with precise text', () => {
  assert.equal(validateModelChoice(CATALOG, { provider: 'mock', model: 'mock-1' }), undefined)
  assert.match(validateModelChoice(CATALOG, { provider: 'nope', model: 'x' }), /unknown provider: nope/)
  assert.match(validateModelChoice(CATALOG, { provider: 'mock', model: 'nope' }), /unknown model: nope for provider mock/)
  // A provider whose catalog read failed lets the route validate at call time.
  assert.equal(validateModelChoice([{ id: 'blind', name: 'Blind', models: [] }], { provider: 'blind', model: 'anything' }), undefined)
})

test('validateEffortChoice accepts default and declared efforts only', () => {
  const reasoning = { efforts: [{ id: 'low', name: 'Low' }] }
  assert.equal(validateEffortChoice(reasoning, DEFAULT_EFFORT_VALUE), undefined)
  assert.equal(validateEffortChoice(reasoning, 'low'), undefined)
  assert.match(validateEffortChoice(reasoning, 'turbo'), /unknown reasoning effort: turbo/)
  assert.match(validateEffortChoice(reasoning, 'turbo'), /accepted: default, low/)
})
