import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildJevRouteQuestions,
  deriveJevHeuristicTitle,
  JEV_MODEL,
  JevRouteError,
  readJevRoute,
} from '../packages/shared/dist/src/jev-router.js'

const CANDIDATES = [
  {
    providerId: 'chatgpt',
    label: 'ChatGPT',
    suitableTasks: 'Writing and editing',
    model: 'gpt-5',
    plan: { accessClass: 'signed_in_plus', planId: 'test-plan', label: 'Test plan' },
    capacity: { decision: 'admit', rules: [] },
  },
  {
    providerId: 'claude',
    label: 'Claude',
    suitableTasks: 'Coding and debugging',
    model: 'claude-sonnet-5',
    plan: { accessClass: 'signed_in_plus', planId: 'test-plan', label: 'Test plan' },
    capacity: { decision: 'admit', rules: [] },
  },
]

test('buildJevRouteQuestions batches providerId choice, taskType choice, and complexity score in one request', () => {
  const questions = buildJevRouteQuestions('Fix the failing login test', CANDIDATES)
  assert.equal(questions.providerId.type, 'choice')
  assert.deepEqual(Object.keys(questions.providerId.criteria), ['chatgpt', 'claude'])
  assert.equal(questions.taskType.type, 'choice')
  assert.ok('coding' in questions.taskType.criteria)
  assert.equal(questions.complexity.type, 'score')
  assert.equal(questions.complexity.criteria.length, 3)
})

test('readJevRoute maps a confident choice+score answer into a HarnessFrontDoorRoute with a synthesized reason', () => {
  const route = readJevRoute({
    providerId: { type: 'choice', choice: 'claude', confidence: 0.91, probabilities: { chatgpt: 0.09, claude: 0.91 } },
    taskType: { type: 'choice', choice: 'coding', confidence: 0.8, probabilities: {} },
    complexity: { type: 'score', score: 1.2, confidence: 0.7, probabilities: {} },
  }, CANDIDATES)

  assert.equal(route.providerId, 'claude')
  assert.equal(route.model, 'claude-sonnet-5')
  assert.equal(route.taskType, 'coding')
  assert.equal(route.complexity, 'medium')
  assert.match(route.reason, /claude/)
  assert.match(route.reason, /91%/)
})

test('readJevRoute clamps out-of-range scores to the nearest complexity level', () => {
  const low = readJevRoute({
    providerId: { type: 'choice', choice: 'chatgpt', confidence: 0.5, probabilities: {} },
    taskType: { type: 'choice', choice: 'writing', confidence: 0.5, probabilities: {} },
    complexity: { type: 'score', score: -1, confidence: 0.5, probabilities: {} },
  }, CANDIDATES)
  assert.equal(low.complexity, 'low')

  const high = readJevRoute({
    providerId: { type: 'choice', choice: 'chatgpt', confidence: 0.5, probabilities: {} },
    taskType: { type: 'choice', choice: 'writing', confidence: 0.5, probabilities: {} },
    complexity: { type: 'score', score: 99, confidence: 0.5, probabilities: {} },
  }, CANDIDATES)
  assert.equal(high.complexity, 'high')
})

test('readJevRoute rejects a provider Jev returns that is not among the candidates', () => {
  assert.throws(() => readJevRoute({
    providerId: { type: 'choice', choice: 'unknown-provider', confidence: 0.5, probabilities: {} },
    taskType: { type: 'choice', choice: 'writing', confidence: 0.5, probabilities: {} },
    complexity: { type: 'score', score: 0, confidence: 0.5, probabilities: {} },
  }, CANDIDATES), JevRouteError)
})

test('readJevRoute rejects a task type outside the fixed taxonomy', () => {
  assert.throws(() => readJevRoute({
    providerId: { type: 'choice', choice: 'chatgpt', confidence: 0.5, probabilities: {} },
    taskType: { type: 'choice', choice: 'not-a-real-category', confidence: 0.5, probabilities: {} },
    complexity: { type: 'score', score: 0, confidence: 0.5, probabilities: {} },
  }, CANDIDATES), JevRouteError)
})

test('deriveJevHeuristicTitle truncates long English task text to eight words', () => {
  const title = deriveJevHeuristicTitle('Draft a confident product launch announcement for the new dashboard feature set')
  assert.equal(title, 'Draft a confident product launch announcement for the...')
})

test('deriveJevHeuristicTitle leaves short English task text untouched', () => {
  assert.equal(deriveJevHeuristicTitle('Fix the login bug'), 'Fix the login bug')
})

test('deriveJevHeuristicTitle truncates long Chinese task text to twenty characters', () => {
  const longChinese = '请帮我起草一份关于新产品发布的公告文案，语气要自信而且专业，覆盖所有关键功能点'
  const title = deriveJevHeuristicTitle(longChinese)
  assert.equal(title, `${longChinese.slice(0, 20)}...`)
})

test('deriveJevHeuristicTitle falls back to a placeholder for empty input', () => {
  assert.equal(deriveJevHeuristicTitle('   '), 'Untitled task')
})

test('JEV_MODEL is the documented default model id', () => {
  assert.equal(JEV_MODEL, 'jev-latest')
})
