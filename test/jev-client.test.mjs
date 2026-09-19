import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Hermetic, isolated home dir so these tests never read or write the developer's
// real ~/.tokenless/config.json (which may itself have a persisted Jev key).
process.env.TOKENLESS_HOME = path.join(os.tmpdir(), `tokenless-jev-test-${randomUUID()}`)

const CANDIDATES = [{
  providerId: 'chatgpt',
  label: 'ChatGPT',
  suitableTasks: 'Writing and editing',
  model: 'gpt-5',
  plan: { accessClass: 'signed_in_plus', planId: 'test-plan', label: 'Test plan' },
  capacity: { decision: 'admit', rules: [] },
}]

const SUCCESSFUL_ROUTE_BODY = {
  model: 'jev-latest',
  answers: {
    providerId: { type: 'choice', choice: 'chatgpt', confidence: 0.87, probabilities: { chatgpt: 0.87 } },
    taskType: { type: 'choice', choice: 'writing', confidence: 0.75, probabilities: { writing: 0.75 } },
    complexity: { type: 'score', score: 0.4, confidence: 0.6, probabilities: { 0: 0.6, 1: 0.3, 2: 0.1 } },
  },
  usage: { input_tokens: 42, output_tokens: 12 },
}

let fetchHandler = async () => new Response(JSON.stringify(SUCCESSFUL_ROUTE_BODY), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

globalThis.fetch = (...args) => fetchHandler(...args)

const { runJevRoute, runJevSystemOne, listJevHistory } = await import('tokenless-internal-server/http/dashboard/jev.js')
const { writeTokenlessConfig } = await import('tokenless-internal-server/persistence/config.js')

// Must run first, before any config.json exists in the isolated home dir and before any
// other test writes a router.jevApiKey there: the key is resolved fresh on every call
// (no persistent client cache), so this observes the true "nothing configured" state.
test('runJevRoute reports a clear error when neither a config key nor TYPESAFE_API_KEY is set', async () => {
  const original = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  try {
    await assert.rejects(
      () => runJevRoute('Draft a launch note', CANDIDATES),
      (error) => {
        assert.equal(error.code, 'jev_api_key_missing')
        assert.equal(error.status, 500)
        return true
      },
    )
  } finally {
    process.env.TYPESAFE_API_KEY = original ?? 'env-key'
  }
})

test('runJevRoute rejects an empty provider list before making any request', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevRoute('Draft a launch note', []),
    (error) => {
      assert.equal(error.code, 'jev_route_candidates_missing')
      assert.equal(error.status, 400)
      return true
    },
  )
  assert.equal(called, false)
})

test('runJevRoute falls back to the TYPESAFE_API_KEY env var when no config key is set', async () => {
  process.env.TYPESAFE_API_KEY = 'env-key'
  let sentAuth = null
  fetchHandler = async (_url, init) => {
    sentAuth = init.headers.Authorization
    return new Response(JSON.stringify(SUCCESSFUL_ROUTE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJevRoute('Draft a launch note', CANDIDATES)
  assert.equal(sentAuth, 'Bearer env-key')
})

test('runJevRoute prefers the dashboard-configured key over the TYPESAFE_API_KEY env var', async () => {
  process.env.TYPESAFE_API_KEY = 'env-key'
  await writeTokenlessConfig({
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: 'config-key' },
  })
  let sentAuth = null
  fetchHandler = async (_url, init) => {
    sentAuth = init.headers.Authorization
    return new Response(JSON.stringify(SUCCESSFUL_ROUTE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJevRoute('Draft a launch note', CANDIDATES)
  assert.equal(sentAuth, 'Bearer config-key')
})

test('runJevRoute clearing the config key (explicit null) falls back to the env var again', async () => {
  await writeTokenlessConfig({
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: null },
  })
  process.env.TYPESAFE_API_KEY = 'env-key-2'
  let sentAuth = null
  fetchHandler = async (_url, init) => {
    sentAuth = init.headers.Authorization
    return new Response(JSON.stringify(SUCCESSFUL_ROUTE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJevRoute('Draft a launch note', CANDIDATES)
  assert.equal(sentAuth, 'Bearer env-key-2')
})

test('runJevRoute batches providerId/taskType/complexity into one systemOne call and maps a confident answer', async () => {
  let sentBody = null
  fetchHandler = async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    sentBody = JSON.parse(init.body)
    return new Response(JSON.stringify(SUCCESSFUL_ROUTE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const { route, latencyMs } = await runJevRoute('Draft a launch note', CANDIDATES)

  assert.deepEqual(Object.keys(sentBody.questions), ['providerId', 'taskType', 'complexity'])
  assert.equal(sentBody.model, 'jev-latest')
  assert.equal(route.providerId, 'chatgpt')
  assert.equal(route.model, 'gpt-5')
  assert.equal(route.taskType, 'writing')
  assert.equal(route.complexity, 'low')
  assert.match(route.reason, /chatgpt/)
  assert.ok(latencyMs >= 0)

  const history = listJevHistory()
  assert.equal(history[0].kind, 'route')
  assert.equal(history[0].error, null)
})

test('runJevRoute maps an HTTP 401 from TypeSafe into an authentication error and records the failure', async () => {
  fetchHandler = async () => new Response(JSON.stringify({ error: 'invalid api key' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(
    () => runJevRoute('Draft a launch note', CANDIDATES),
    (error) => {
      assert.equal(error.code, 'jev_authentication_failed')
      assert.equal(error.status, 401)
      return true
    },
  )
  const history = listJevHistory()
  assert.equal(history[0].kind, 'route')
  assert.ok(history[0].error)
})

test('runJevRoute maps an HTTP 429 into a rate-limit error', async () => {
  fetchHandler = async () => new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(
    () => runJevRoute('Draft a launch note', CANDIDATES),
    (error) => {
      assert.equal(error.code, 'jev_rate_limited')
      assert.equal(error.status, 429)
      return true
    },
  )
})

// --- Strict JSON input validation for the raw systemone playground path -------------------
// This is the path a user can hand arbitrary hand-typed JSON to, so it gets the deepest
// coverage: every rejection below must fire before any network call is attempted.

test('runJevSystemOne rejects a non-object questions value', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: 'not-an-object' }),
    (error) => { assert.equal(error.code, 'jev_questions_invalid'); assert.equal(error.status, 400); return true },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects an array passed as questions', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: [{ type: 'noul' }] }),
    (error) => { assert.equal(error.code, 'jev_questions_invalid'); return true },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects an empty questions object', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: {} }),
    (error) => { assert.equal(error.code, 'jev_questions_invalid'); return true },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects a question value that is not an object', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: { urgency: 'not-an-object' } }),
    (error) => { assert.equal(error.code, 'jev_questions_invalid'); return true },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects questions missing a valid type', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: { urgency: { instructions: 'no type field' } } }),
    (error) => {
      assert.equal(error.code, 'jev_questions_invalid')
      assert.equal(error.status, 400)
      return true
    },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects an unrecognized question type value', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({ state: 'hello', questions: { urgency: { type: 'freeform', instructions: 'x' } } }),
    (error) => { assert.equal(error.code, 'jev_questions_invalid'); return true },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects score criteria that are not a list of at least two levels, without a network call', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(
    () => runJevSystemOne({
      state: 'hello',
      questions: { complexity: { type: 'score', instructions: 'How hard is this?', criteria: ['only one level'] } },
    }),
    (error) => {
      // Caught from the SDK's own local validateQuestions(), before any HTTP request.
      assert.equal(error.code, 'jev_client_error')
      assert.equal(error.status, 400)
      return true
    },
  )
  assert.equal(called, false)
})

test('runJevSystemOne rejects null/undefined/empty-string state before making any request', async () => {
  let called = false
  fetchHandler = async () => { called = true; throw new Error('should not be called') }
  const questions = { urgency: { type: 'noul', instructions: 'Is this urgent?' } }
  for (const badState of [null, undefined, '']) {
    await assert.rejects(
      () => runJevSystemOne({ state: badState, questions }),
      (error) => { assert.equal(error.code, 'jev_state_missing'); assert.equal(error.status, 400); return true },
    )
  }
  assert.equal(called, false)
})

test('runJevSystemOne accepts a plain non-empty string as state', async () => {
  let sentBody = null
  fetchHandler = async (_url, init) => {
    sentBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      model: 'jev-latest',
      answers: { urgency: { type: 'noul', noul: 0.2 } },
      usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJevSystemOne({ state: 'a plain text task description', questions: { urgency: { type: 'noul', instructions: 'Is this urgent?' } } })
  assert.equal(sentBody.state, 'a plain text task description')
})

test('runJevSystemOne forwards state/questions/model and returns the raw structured answer plus latency', async () => {
  const body = {
    model: 'jev-latest',
    answers: { urgency: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 10, output_tokens: 3 },
  }
  let sentBody = null
  fetchHandler = async (_url, init) => {
    sentBody = JSON.parse(init.body)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await runJevSystemOne({
    state: { document: 'I was charged twice.' },
    questions: { urgency: { type: 'noul', instructions: 'Does this express urgency?' } },
  })

  assert.deepEqual(sentBody.state, { document: 'I was charged twice.' })
  assert.equal(result.model, 'jev-latest')
  assert.deepEqual(result.answers, { urgency: { type: 'noul', noul: 0.93 } })
  assert.ok(result.latencyMs >= 0)

  const history = listJevHistory()
  assert.equal(history[0].kind, 'systemone')
  assert.equal(history[0].error, null)
})
