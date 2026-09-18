import { createHash } from 'node:crypto'
import { normalizeProviderResponse } from '../../packages/harness/dist/src/http/bootstrap.js'
import { parseStrictJson } from '../../packages/shared/dist/src/structured-json.js'

const opening = '<TOKENLESS_HARNESS_RESPONSE>'
const closing = '</TOKENLESS_HARNESS_RESPONSE>'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const raw = Buffer.concat(chunks).toString('utf8')
let normalizationApplied = null
let result
try {
  // Record proposals using production normalization; execution eligibility is the Harness's decision.
  // An action_batch status does not assert nonce, protocol, or tool-contract acceptance.
  const normalized = normalizeProviderResponse(raw)
  normalizationApplied = normalized !== raw.trim()
  const value = parseStrictJson(normalized.slice(opening.length, -closing.length))
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['action_batch', 'final'].includes(value.kind)
    || value.kind === 'action_batch' && (!Array.isArray(value.calls) || value.calls.length > 128)) {
    result = { status: 'invalid_response', normalizationApplied }
  } else {
    const calls = value.kind === 'action_batch' ? value.calls : []
    if (calls.some((call) => !call || typeof call !== 'object'
      || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(call.id)
      || typeof call.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(call.tool)
      || call.arguments === undefined)) {
      result = { status: 'invalid_response', normalizationApplied }
    } else {
      result = {
        status: value.kind,
        normalizationApplied,
        calls: calls.map((call) => {
          const argumentsJson = JSON.stringify(call.arguments)
          return {
            id: call.id,
            tool: call.tool,
            arguments: {
              availability: 'observed',
              bytes: Buffer.byteLength(argumentsJson),
              sha256: createHash('sha256').update(argumentsJson).digest('hex'),
            },
          }
        }),
      }
    }
  }
} catch (error) {
  // Never emit the exception message: JSON parser errors can contain provider text.
  result = {
    status: error?.code === 'harness_response_framing_invalid' ? 'invalid_framing' : 'invalid_json',
    normalizationApplied,
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`)
