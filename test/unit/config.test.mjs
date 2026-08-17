/**
 * Config schema behavior: defaults fill every field (so partial user
 * overrides in a profile patch layer are safe), wrong types fail loudly at
 * load, and the provider/model pin is both-or-neither.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, modelSelectionOf, validateModelPin } from '../../lib/config.js'

test('Config fills defaults for an empty config', () => {
  const config = Config({})
  assert.equal(config.agentName, 'dsh')
  assert.equal(config.offerAlwaysPermissions, true)
  assert.equal(config.flushOnTurnEnd, true)
  // Absent strings stay unset (the model pin is optional).
  assert.equal('provider' in config, false)
  assert.equal('model' in config, false)
})

test('Config keeps explicit values', () => {
  const config = Config({ agentName: 'my-dsh', provider: 'deepseek', model: 'reasoner', offerAlwaysPermissions: false, flushOnTurnEnd: false })
  assert.equal(config.agentName, 'my-dsh')
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.model, 'reasoner')
  assert.equal(config.offerAlwaysPermissions, false)
  assert.equal(config.flushOnTurnEnd, false)
})

test('Config fails loudly on wrong types', () => {
  assert.throws(() => Config({ provider: 42 }), /expected string/)
  assert.throws(() => Config({ flushOnTurnEnd: 'yes' }), /expected boolean/)
})

test('validateModelPin enforces both-or-neither', () => {
  assert.doesNotThrow(() => validateModelPin(Config({})))
  assert.doesNotThrow(() => validateModelPin(Config({ provider: 'p', model: 'm' })))
  assert.throws(() => validateModelPin(Config({ provider: 'p' })), /must be set together/)
  assert.throws(() => validateModelPin(Config({ model: 'm' })), /must be set together/)
})

test('modelSelectionOf prefers the pin over the profile default', () => {
  const fallback = { provider: 'default-p', model: 'default-m' }
  assert.deepEqual(modelSelectionOf(Config({}), fallback), fallback)
  assert.deepEqual(
    modelSelectionOf(Config({ provider: 'pinned-p', model: 'pinned-m' }), fallback),
    { provider: 'pinned-p', model: 'pinned-m' },
  )
})
