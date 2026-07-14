import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const {
  MANAGED_RESPONSES_DEFAULT_MODEL,
  MANAGED_RESPONSES_DELTA_BYTES,
  MAX_MANAGED_RESPONSES_BODY_BYTES,
  MAX_MANAGED_RESPONSES_INPUT_BYTES,
  MAX_MANAGED_RESPONSES_MODEL_BYTES,
  MAX_MANAGED_RESPONSES_OUTPUT_BYTES,
  createManagedResponsesEvents,
  createManagedResponsesResponse,
  createManagedResponsesSse,
  encodeManagedResponsesSse,
  parseManagedResponsesRequest,
} = await import(new URL('managed-responses.js', directModuleRoot))

test('managed Responses parser accepts only the stateless text subset and preserves input', () => {
  assert.deepEqual(parseManagedResponsesRequest(Buffer.from(JSON.stringify({
    input: '  Keep spacing. \n',
    model: ' codex-test ',
    stream: true,
    store: false,
  }))), {
    input: '  Keep spacing. \n',
    model: 'codex-test',
    stream: true,
    store: false,
  })
  assert.deepEqual(parseManagedResponsesRequest('{"input":"Hello"}'), {
    input: 'Hello',
    stream: false,
    store: false,
  })

  for (const payload of [
    null,
    [],
    {},
    { input: 1 },
    { input: '   \n\t' },
    { input: 'Hello', stream: 'true' },
    { input: 'Hello', store: true },
    { input: 'Hello', model: '' },
    { input: 'Hello', instructions: 'system text' },
    { input: 'Hello', tools: [] },
    { input: 'Hello', previous_response_id: 'resp_other' },
    { input: 'Hello', conversation: 'conv_other' },
    { input: 'Hello', temperature: 0 },
  ]) {
    assert.throws(
      () => parseManagedResponsesRequest(JSON.stringify(payload)),
      (error) => error.code === 'direct_configuration_error',
      JSON.stringify(payload),
    )
  }
})

test('managed Responses parser enforces fatal UTF-8, Unicode scalar, and byte bounds', () => {
  assert.throws(
    () => parseManagedResponsesRequest(Uint8Array.from([0x7b, 0xff, 0x7d])),
    (error) => error.code === 'direct_configuration_error' && /UTF-8/.test(error.message),
  )
  assert.throws(
    () => parseManagedResponsesRequest('{"input":"\\ud800"}'),
    (error) => error.code === 'direct_configuration_error' && /Unicode/.test(error.message),
  )
  assert.throws(
    () => parseManagedResponsesRequest(`{"input":"${String.fromCharCode(0xd800)}"}`),
    (error) => error.code === 'direct_configuration_error' && /Unicode/.test(error.message),
  )
  assert.throws(
    () => parseManagedResponsesRequest(Buffer.alloc(MAX_MANAGED_RESPONSES_BODY_BYTES + 1, 0x20)),
    (error) => error.code === 'direct_request_too_large',
  )
  assert.throws(
    () => parseManagedResponsesRequest(JSON.stringify({ input: `x${'🙂'.repeat(MAX_MANAGED_RESPONSES_INPUT_BYTES / 4)}` })),
    (error) => error.code === 'direct_request_too_large',
  )
  assert.equal(
    Buffer.byteLength(parseManagedResponsesRequest(JSON.stringify({
      input: 'x'.repeat(MAX_MANAGED_RESPONSES_INPUT_BYTES),
    })).input, 'utf8'),
    MAX_MANAGED_RESPONSES_INPUT_BYTES,
  )
  assert.equal(
    Buffer.byteLength(parseManagedResponsesRequest(JSON.stringify({
      input: 'x',
      model: 'm'.repeat(MAX_MANAGED_RESPONSES_MODEL_BYTES),
    })).model, 'utf8'),
    MAX_MANAGED_RESPONSES_MODEL_BYTES,
  )
  assert.throws(
    () => parseManagedResponsesRequest(JSON.stringify({
      input: 'x',
      model: `m${'🙂'.repeat(MAX_MANAGED_RESPONSES_MODEL_BYTES / 4)}`,
    })),
    (error) => error.code === 'direct_configuration_error' && /model/.test(error.message),
  )
})

test('managed Responses object is deterministic when metadata is injected and never echoes input', () => {
  const request = parseManagedResponsesRequest(JSON.stringify({ input: 'secret project prompt', store: false }))
  const response = createManagedResponsesResponse(request, 'Visible answer. ', {
    responseId: 'resp_tokenless_12345678',
    messageId: 'msg_tokenless_abcdefgh',
    createdAt: 1_800_000_000,
  })
  assert.equal(response.id, 'resp_tokenless_12345678')
  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.model, MANAGED_RESPONSES_DEFAULT_MODEL)
  assert.equal(response.store, false)
  assert.equal(response.output[0].id, 'msg_tokenless_abcdefgh')
  assert.equal(response.output[0].content[0].text, 'Visible answer. ')
  assert.equal(response.output[0].content[0].type, 'output_text')
  assert.equal(response.usage, null)
  assert.doesNotMatch(JSON.stringify(response), /secret project prompt/)
  assert.throws(
    () => createManagedResponsesResponse(request, 'answer', { responseId: 'provider-controlled' }),
    (error) => error.code === 'direct_configuration_error',
  )
  for (const invalidRequest of [
    { input: ' ', stream: false, store: false },
    { input: 'Hello', model: ' not-normalized ', stream: false, store: false },
    { input: 'Hello', stream: false, store: false, project: 'must-not-be-accepted' },
  ]) {
    assert.throws(
      () => createManagedResponsesResponse(invalidRequest, 'answer'),
      (error) => error.code === 'direct_configuration_error',
    )
  }
})

test('managed Responses output accepts its exact byte limit and rejects one scalar beyond it', () => {
  const request = parseManagedResponsesRequest('{"input":"Hello"}')
  const exact = 'x'.repeat(MAX_MANAGED_RESPONSES_OUTPUT_BYTES)
  assert.equal(
    Buffer.byteLength(createManagedResponsesResponse(request, exact).output[0].content[0].text, 'utf8'),
    MAX_MANAGED_RESPONSES_OUTPUT_BYTES,
  )
  assert.throws(
    () => createManagedResponsesResponse(request, `x${'🙂'.repeat(MAX_MANAGED_RESPONSES_OUTPUT_BYTES / 4)}`),
    (error) => error.code === 'direct_invalid_response',
  )
})

test('managed Responses SSE uses typed ordered events, bounded UTF-8 deltas, and no sentinel', () => {
  const request = parseManagedResponsesRequest(JSON.stringify({ input: 'secret project prompt', model: 'codex-test', stream: true }))
  const text = `${'a'.repeat(MANAGED_RESPONSES_DELTA_BYTES - 1)}🙂tail`
  const response = createManagedResponsesResponse(request, text, {
    responseId: 'resp_tokenless_12345678',
    messageId: 'msg_tokenless_abcdefgh',
    createdAt: 1_800_000_000,
  })
  const events = createManagedResponsesEvents(response)
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))
  const deltas = events.filter((event) => event.type === 'response.output_text.delta')
  assert.equal(deltas.map((event) => event.delta).join(''), text)
  assert.ok(deltas.every((event) => Buffer.byteLength(event.delta, 'utf8') <= MANAGED_RESPONSES_DELTA_BYTES))

  const frames = createManagedResponsesSse(response)
  assert.equal(frames.length, events.length)
  for (let index = 0; index < frames.length; index += 1) {
    assert.ok(frames[index].startsWith(`event: ${events[index].type}\ndata: `))
    assert.ok(frames[index].endsWith('\n\n'))
    assert.equal(JSON.parse(frames[index].split('\ndata: ')[1].trim()).sequence_number, index)
  }
  const encoded = encodeManagedResponsesSse(response)
  assert.equal(encoded, frames.join(''))
  assert.doesNotMatch(encoded, /\[DONE\]|secret project|turn\.completed|thread_id/)

  assert.throws(
    () => createManagedResponsesEvents({ ...response, project: 'secret project' }),
    (error) => error.code === 'direct_configuration_error',
  )
  assert.throws(
    () => createManagedResponsesEvents({
      ...response,
      output: [{
        ...response.output[0],
        content: [{ ...response.output[0].content[0], thread_id: 'internal-thread' }],
      }],
    }),
    (error) => error.code === 'direct_configuration_error',
  )
})
