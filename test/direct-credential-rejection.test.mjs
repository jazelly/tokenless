import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const {
  MAX_CREDENTIAL_REJECTION_BYTES,
  isCredentialRejection,
} = await import(new URL('credential-rejection.js', directModuleRoot))

const OPENAI_INVALID = {
  error: {
    message: 'redacted human message',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
}
const ANTHROPIC_INVALID = {
  type: 'error',
  error: { type: 'authentication_error', message: 'redacted human message' },
  request_id: 'req_test',
}
const GOOGLE_INVALID = {
  error: {
    code: 400,
    message: 'redacted human message',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' },
      },
    ],
  },
}
const XAI_UNAUTHORIZED = {
  code: 'Unauthorized',
  error: 'redacted human message',
}

test('credential rejection classifier admits only exact complete provider contracts', () => {
  assert.equal(classify('chatgpt', 401, OPENAI_INVALID), true)
  assert.equal(classify('claude', 401, ANTHROPIC_INVALID), true)
  assert.equal(classify('gemini', 400, GOOGLE_INVALID), true)
  assert.equal(classify('grok', 401, XAI_UNAUTHORIZED), true)
  assert.equal(classify('antigravity', 401, ANTHROPIC_INVALID, { compatibility: 'anthropic' }), true)
  assert.equal(classify('antigravity', 400, GOOGLE_INVALID, { compatibility: 'google' }), true)
})

test('credential rejection classifier never treats permission, quota, transient, or ambiguous errors as bad credentials', () => {
  for (const provider of ['chatgpt', 'claude', 'gemini', 'grok', 'antigravity']) {
    assert.equal(classify(provider, 403, OPENAI_INVALID), false)
    assert.equal(classify(provider, 429, { error: { code: 'rate_limit_exceeded' } }), false)
    assert.equal(classify(provider, 500, { error: { code: 'invalid_api_key' } }), false)
  }

  assert.equal(classify('chatgpt', 401, { error: { code: 'invalid_api_key' } }), false)
  assert.equal(classify('claude', 401, {
    type: 'error',
    error: { type: 'authentication_error', message: 'x' },
  }), false)
  assert.equal(classify('grok', 401, { error: 'x' }), false)
  assert.equal(classify('grok', 400, XAI_UNAUTHORIZED), false)
  assert.equal(classify('grok', 401, { code: 'rate_limited', error: 'gateway policy' }), false)
  assert.equal(classify('grok', 401, { code: 'Forbidden', error: 'team policy' }), false)
  assert.equal(classify('grok', 401, { code: 'unauthorized', error: 'wrong casing' }), false)
  assert.equal(classify('gemini', 400, {
    error: {
      ...GOOGLE_INVALID.error,
      details: [{
        ...GOOGLE_INVALID.error.details[0],
        reason: 'API_KEY_SERVICE_BLOCKED',
      }],
    },
  }), false)
  assert.equal(classify('antigravity', 401, ANTHROPIC_INVALID), false)
  assert.equal(classify('antigravity', 401, OPENAI_INVALID, { compatibility: 'anthropic' }), false)
})

test('credential rejection classifier fails closed on non-JSON, invalid UTF-8, truncation, and oversize bodies', () => {
  assert.equal(isCredentialRejection({
    provider: 'chatgpt',
    statusCode: 401,
    contentType: 'text/html',
    body: Buffer.from(JSON.stringify(OPENAI_INVALID)),
    complete: true,
  }), false)
  assert.equal(isCredentialRejection({
    provider: 'chatgpt',
    statusCode: 401,
    contentType: 'application/json',
    body: Buffer.from('{'),
    complete: true,
  }), false)
  assert.equal(isCredentialRejection({
    provider: 'chatgpt',
    statusCode: 401,
    contentType: 'application/json',
    body: Buffer.from([0xc3, 0x28]),
    complete: true,
  }), false)
  assert.equal(isCredentialRejection({
    provider: 'chatgpt',
    statusCode: 401,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(OPENAI_INVALID)),
    complete: false,
  }), false)
  assert.equal(isCredentialRejection({
    provider: 'chatgpt',
    statusCode: 401,
    contentType: 'application/json',
    body: Buffer.alloc(MAX_CREDENTIAL_REJECTION_BYTES + 1, 0x20),
    complete: true,
  }), false)
})

function classify(provider, statusCode, body, options = {}) {
  return isCredentialRejection({
    provider,
    statusCode,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(body)),
    complete: true,
    ...options,
  })
}
