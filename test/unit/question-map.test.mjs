import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import {
  answersFromElicitation, answersFromPermission, autoAnswerOf,
  elicitationOf, permissionFallbackOf, SKIP_OPTION_ID,
} from '../../lib/question-map.js'
import { autoFormContent, questionsOfForm, replyToContent } from '../../lib/cli/control-core.js'

const questions = [
  { id: 'color', header: 'Color', question: 'Pick a color', detail: 'For the interface', options: [{ label: 'red', description: 'Recommended' }, { label: 'blue' }] },
  { id: 'features', question: 'Pick features', multiSelect: true, options: [{ label: 'search' }, { label: 'export' }] },
  { id: 'name', question: 'Project name?' },
]

test('question batches survive SDK validation and terminal answers round-trip', () => {
  const request = elicitationOf('session-1', 'call-1', questions)
  assert.equal(CreateElicitationRequest.isForm(request), true, 'SDK accepts the complete form schema')
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.toolCallId, 'call-1')
  const form = questionsOfForm(request.requestedSchema)
  assert.equal(form.length, 3, 'free-text companion fields are folded into their question')
  assert.equal(form[0].description, 'Pick a color\n\nFor the interface')
  const content = {
    ...replyToContent(form[0], '2'),
    ...replyToContent(form[1], '1,2'),
    ...replyToContent(form[2], ' My project '),
  }
  assert.deepEqual(answersFromElicitation(questions, content), { answers: [
    { id: 'color', selected: ['blue'] },
    { id: 'features', selected: ['search', 'export'] },
    { id: 'name', selected: [], custom: 'My project' },
  ] })
})

test('option questions preserve custom replies and reject unoffered selections', () => {
  const form = questionsOfForm(elicitationOf('s', undefined, questions).requestedSchema)
  assert.deepEqual(answersFromElicitation(questions, replyToContent(form[0], 'green')).answers[0],
    { id: 'color', selected: [], custom: 'green' })
  assert.deepEqual(answersFromElicitation(questions, { color: ['bogus', 'red', 'blue'], features: ['bogus', 'export'] }).answers,
    [{ id: 'color', selected: ['red'] }, { id: 'features', selected: ['export'] }, { id: 'name', selected: [] }])
  assert.deepEqual(answersFromElicitation(questions, null), { answers: questions.map(({ id }) => ({ id, selected: [] })) })
})

test('unattended and default terminal answers agree on recommended choices', () => {
  const form = questionsOfForm(elicitationOf('s', undefined, questions).requestedSchema)
  assert.deepEqual(answersFromElicitation(questions, autoFormContent(form)), autoAnswerOf(questions))
  assert.deepEqual(replyToContent(form[0], ''), { color: 'red' })
  assert.deepEqual(replyToContent(form[1], ''), { features: ['search'] })
  assert.deepEqual(replyToContent(form[2], ''), {})
})

test('permission fallback represents only one single-select question', () => {
  assert.equal(permissionFallbackOf(questions), undefined)
  assert.equal(permissionFallbackOf([questions[1]]), undefined)
  assert.equal(permissionFallbackOf([questions[2]]), undefined)
  const options = permissionFallbackOf([questions[0]])
  assert.equal(options.at(-1).optionId, SKIP_OPTION_ID)
  assert.deepEqual(answersFromPermission([questions[0]], options[1].optionId), { answers: [{ id: 'color', selected: ['blue'] }] })
  assert.deepEqual(answersFromPermission([questions[0]], 'invalid'), { answers: [{ id: 'color', selected: [] }] })
})
