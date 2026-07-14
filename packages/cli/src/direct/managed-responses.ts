import { randomUUID } from 'node:crypto'

import { DirectError } from './types.js'

export const MANAGED_RESPONSES_DEFAULT_MODEL = 'tokenless-codex-default' as const
export const MAX_MANAGED_RESPONSES_INPUT_BYTES = 4 * 1024 * 1024
export const MAX_MANAGED_RESPONSES_BODY_BYTES = MAX_MANAGED_RESPONSES_INPUT_BYTES + 64 * 1024
export const MAX_MANAGED_RESPONSES_MODEL_BYTES = 256
export const MAX_MANAGED_RESPONSES_OUTPUT_BYTES = 2 * 1024 * 1024
export const MANAGED_RESPONSES_DELTA_BYTES = 8 * 1024

const RESPONSE_ID_PATTERN = /^resp_tokenless_[A-Za-z0-9_-]{8,128}$/
const MESSAGE_ID_PATTERN = /^msg_tokenless_[A-Za-z0-9_-]{8,128}$/
const REQUEST_KEYS = new Set(['input', 'model', 'stream', 'store'])
const CREATED_RESPONSES = new WeakSet<object>()

export type ManagedResponsesRequest = Readonly<{
  input: string
  model?: string | undefined
  stream: boolean
  store: false
}>

export type ManagedResponsesMetadata = Readonly<{
  responseId?: string | undefined
  messageId?: string | undefined
  createdAt?: number | undefined
}>

export type ManagedResponseContent = Readonly<{
  type: 'output_text'
  annotations: readonly never[]
  logprobs: readonly never[]
  text: string
}>

export type ManagedResponseMessage = Readonly<{
  id: string
  type: 'message'
  status: 'completed'
  role: 'assistant'
  content: readonly [ManagedResponseContent]
}>

export type ManagedResponse = Readonly<{
  id: string
  object: 'response'
  created_at: number
  completed_at: number
  status: 'completed'
  error: null
  incomplete_details: null
  instructions: null
  max_output_tokens: null
  metadata: Readonly<Record<string, never>>
  model: string
  output: readonly [ManagedResponseMessage]
  parallel_tool_calls: false
  previous_response_id: null
  reasoning: Readonly<{ effort: null; summary: null }>
  store: false
  temperature: null
  text: Readonly<{ format: Readonly<{ type: 'text' }> }>
  tool_choice: 'auto'
  tools: readonly never[]
  top_p: null
  truncation: 'disabled'
  usage: null
}>

export type ManagedResponseInProgress = Readonly<
  Omit<ManagedResponse, 'completed_at' | 'output' | 'status'> & {
    completed_at: null
    output: readonly never[]
    status: 'in_progress'
  }
>

export type ManagedResponsePendingMessage = Readonly<
  Omit<ManagedResponseMessage, 'content' | 'status'> & {
    content: readonly never[]
    status: 'in_progress'
  }
>

export type ManagedResponsePendingContent = Readonly<Omit<ManagedResponseContent, 'text'> & { text: '' }>

export type ManagedResponseEvent =
  | Readonly<{
    type: 'response.created' | 'response.in_progress'
    sequence_number: number
    response: ManagedResponseInProgress
  }>
  | Readonly<{
    type: 'response.output_item.added'
    sequence_number: number
    output_index: 0
    item: ManagedResponsePendingMessage
  }>
  | Readonly<{
    type: 'response.content_part.added'
    sequence_number: number
    item_id: string
    output_index: 0
    content_index: 0
    part: ManagedResponsePendingContent
  }>
  | Readonly<{
    type: 'response.output_text.delta'
    sequence_number: number
    item_id: string
    output_index: 0
    content_index: 0
    delta: string
    logprobs: readonly never[]
  }>
  | Readonly<{
    type: 'response.output_text.done'
    sequence_number: number
    item_id: string
    output_index: 0
    content_index: 0
    text: string
    logprobs: readonly never[]
  }>
  | Readonly<{
    type: 'response.content_part.done'
    sequence_number: number
    item_id: string
    output_index: 0
    content_index: 0
    part: ManagedResponseContent
  }>
  | Readonly<{
    type: 'response.output_item.done'
    sequence_number: number
    output_index: 0
    item: ManagedResponseMessage
  }>
  | Readonly<{
    type: 'response.completed'
    sequence_number: number
    response: ManagedResponse
  }>

type ManagedResponseEventWithoutSequence = ManagedResponseEvent extends infer Event
  ? Event extends { sequence_number: number }
    ? Omit<Event, 'sequence_number'>
    : never
  : never

export function parseManagedResponsesRequest(body: string | Uint8Array): ManagedResponsesRequest {
  if (typeof body === 'string') assertUnicodeScalarText(body, 'request body')
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  if (bytes.byteLength === 0) throw invalidRequest('The managed Responses request body must not be empty.')
  if (bytes.byteLength > MAX_MANAGED_RESPONSES_BODY_BYTES) {
    throw new DirectError('direct_request_too_large', 'The managed Responses request body exceeded the supported size limit.')
  }

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidRequest('The managed Responses request body must be valid UTF-8 JSON.')
  }

  let payload: unknown
  try {
    payload = JSON.parse(decoded) as unknown
  } catch {
    throw invalidRequest('The managed Responses request body must be valid JSON.')
  }
  if (!isRecord(payload)) throw invalidRequest('The managed Responses request body must be a JSON object.')

  for (const key of Object.keys(payload)) {
    if (!REQUEST_KEYS.has(key)) {
      throw invalidRequest(`The managed Responses request field ${key} is not supported.`)
    }
  }
  if (!Object.hasOwn(payload, 'input') || typeof payload.input !== 'string') {
    throw invalidRequest('The managed Responses request requires one string input field.')
  }
  assertUnicodeScalarText(payload.input, 'input')
  if (!/\S/u.test(payload.input)) throw invalidRequest('The managed Responses input must not be empty or whitespace-only.')
  if (Buffer.byteLength(payload.input, 'utf8') > MAX_MANAGED_RESPONSES_INPUT_BYTES) {
    throw new DirectError('direct_request_too_large', 'The managed Responses input exceeded the supported size limit.')
  }

  let model: string | undefined
  if (Object.hasOwn(payload, 'model')) {
    if (typeof payload.model !== 'string') throw invalidRequest('The managed Responses model must be a string.')
    assertUnicodeScalarText(payload.model, 'model')
    model = payload.model.trim()
    if (model === '' || /[\u0000-\u001f\u007f]/u.test(model)) {
      throw invalidRequest('The managed Responses model must be a nonempty string without control characters.')
    }
    if (Buffer.byteLength(model, 'utf8') > MAX_MANAGED_RESPONSES_MODEL_BYTES) {
      throw invalidRequest('The managed Responses model exceeded the supported size limit.')
    }
  }

  if (Object.hasOwn(payload, 'stream') && typeof payload.stream !== 'boolean') {
    throw invalidRequest('The managed Responses stream field must be a boolean.')
  }
  if (Object.hasOwn(payload, 'store') && payload.store !== false) {
    throw invalidRequest('The managed Responses store field, when present, must be false.')
  }
  const stream = Object.hasOwn(payload, 'stream') ? payload.stream as boolean : false

  return Object.freeze({
    input: payload.input,
    ...(model === undefined ? {} : { model }),
    stream,
    store: false,
  })
}

export function createManagedResponsesResponse(
  request: ManagedResponsesRequest,
  text: string,
  metadata: ManagedResponsesMetadata = {},
): ManagedResponse {
  validateManagedRequestValue(request)
  const outputText = validateOutputText(text)
  const responseId = validateGeneratedId(
    metadata.responseId ?? `resp_tokenless_${compactUuid()}`,
    RESPONSE_ID_PATTERN,
    'response',
  )
  const messageId = validateGeneratedId(
    metadata.messageId ?? `msg_tokenless_${compactUuid()}`,
    MESSAGE_ID_PATTERN,
    'message',
  )
  const createdAt = validateCreatedAt(metadata.createdAt ?? Math.floor(Date.now() / 1_000))
  const content: ManagedResponseContent = Object.freeze({
    type: 'output_text',
    annotations: Object.freeze([]),
    logprobs: Object.freeze([]),
    text: outputText,
  })
  const message: ManagedResponseMessage = Object.freeze({
    id: messageId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: Object.freeze([content] as [ManagedResponseContent]),
  })

  const response: ManagedResponse = Object.freeze({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: createdAt,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: Object.freeze({}),
    model: request.model ?? MANAGED_RESPONSES_DEFAULT_MODEL,
    output: Object.freeze([message] as [ManagedResponseMessage]),
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: Object.freeze({ effort: null, summary: null }),
    store: false,
    temperature: null,
    text: Object.freeze({ format: Object.freeze({ type: 'text' }) }),
    tool_choice: 'auto',
    tools: Object.freeze([]),
    top_p: null,
    truncation: 'disabled',
    usage: null,
  })
  CREATED_RESPONSES.add(response)
  return response
}

export function createManagedResponsesEvents(response: ManagedResponse): readonly ManagedResponseEvent[] {
  const completed = validateManagedResponse(response)
  const message = completed.output[0]
  const content = message.content[0]
  const initialResponse: ManagedResponseInProgress = Object.freeze({
    ...completed,
    completed_at: null,
    status: 'in_progress',
    output: Object.freeze([]),
  })
  const pendingMessage: ManagedResponsePendingMessage = Object.freeze({
    ...message,
    status: 'in_progress',
    content: Object.freeze([]),
  })
  const pendingContent: ManagedResponsePendingContent = Object.freeze({ ...content, text: '' })
  const events: ManagedResponseEvent[] = []
  const add = (event: ManagedResponseEventWithoutSequence) => {
    events.push(Object.freeze({
      ...event,
      sequence_number: events.length,
    }) as ManagedResponseEvent)
  }

  add({ type: 'response.created', response: initialResponse })
  add({ type: 'response.in_progress', response: initialResponse })
  add({ type: 'response.output_item.added', output_index: 0, item: pendingMessage })
  add({
    type: 'response.content_part.added',
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    part: pendingContent,
  })
  for (const delta of splitUtf8(content.text, MANAGED_RESPONSES_DELTA_BYTES)) {
    add({
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: Object.freeze([]),
    })
  }
  add({
    type: 'response.output_text.done',
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    text: content.text,
    logprobs: Object.freeze([]),
  })
  add({
    type: 'response.content_part.done',
    item_id: message.id,
    output_index: 0,
    content_index: 0,
    part: content,
  })
  add({ type: 'response.output_item.done', output_index: 0, item: message })
  add({ type: 'response.completed', response: completed })
  return Object.freeze(events)
}

export function createManagedResponsesSse(response: ManagedResponse): readonly string[] {
  return Object.freeze(createManagedResponsesEvents(response).map((event) => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )))
}

export function encodeManagedResponsesSse(response: ManagedResponse): string {
  return createManagedResponsesSse(response).join('')
}

function validateManagedRequestValue(request: ManagedResponsesRequest): void {
  if (!isRecord(request) || typeof request.input !== 'string' || typeof request.stream !== 'boolean' || request.store !== false) {
    throw invalidRequest('A validated managed Responses request is required.')
  }
  if (Object.keys(request).some((key) => !REQUEST_KEYS.has(key))) {
    throw invalidRequest('A validated managed Responses request is required.')
  }
  assertUnicodeScalarText(request.input, 'input')
  if (!/\S/u.test(request.input) || Buffer.byteLength(request.input, 'utf8') > MAX_MANAGED_RESPONSES_INPUT_BYTES) {
    throw invalidRequest('A validated managed Responses request is required.')
  }
  if (request.model !== undefined) {
    if (typeof request.model !== 'string') throw invalidRequest('A validated managed Responses request is required.')
    assertUnicodeScalarText(request.model, 'model')
    if (
      request.model === '' ||
      request.model !== request.model.trim() ||
      /[\u0000-\u001f\u007f]/u.test(request.model) ||
      Buffer.byteLength(request.model, 'utf8') > MAX_MANAGED_RESPONSES_MODEL_BYTES
    ) {
      throw invalidRequest('A validated managed Responses request is required.')
    }
  }
}

function validateManagedResponse(value: ManagedResponse): ManagedResponse {
  if (
    !CREATED_RESPONSES.has(value) ||
    !isRecord(value) ||
    value.object !== 'response' ||
    value.status !== 'completed' ||
    !Array.isArray(value.output) ||
    value.output.length !== 1 ||
    !isRecord(value.output[0]) ||
    !Array.isArray(value.output[0].content) ||
    value.output[0].content.length !== 1 ||
    !isRecord(value.output[0].content[0]) ||
    typeof value.output[0].content[0].text !== 'string'
  ) {
    throw invalidRequest('A completed managed Responses value is required for streaming.')
  }
  return value
}

function validateOutputText(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('Managed Responses output must be a string.')
  assertUnicodeScalarText(value, 'output')
  if (!/\S/u.test(value)) throw invalidRequest('Managed Responses output must not be empty or whitespace-only.')
  if (Buffer.byteLength(value, 'utf8') > MAX_MANAGED_RESPONSES_OUTPUT_BYTES) {
    throw new DirectError('direct_invalid_response', 'The managed Responses output exceeded the supported size limit.')
  }
  return value
}

function validateGeneratedId(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalidRequest(`The managed Responses ${label} id is invalid.`)
  }
  return value
}

function validateCreatedAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidRequest('The managed Responses creation timestamp is invalid.')
  }
  return Number(value)
}

function splitUtf8(value: string, maximumBytes: number): readonly string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (currentBytes > 0 && currentBytes + bytes > maximumBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += bytes
  }
  if (current !== '') chunks.push(current)
  return Object.freeze(chunks)
}

function assertUnicodeScalarText(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw invalidRequest(`The managed Responses ${label} contains invalid Unicode.`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidRequest(`The managed Responses ${label} contains invalid Unicode.`)
    }
  }
}

function compactUuid(): string {
  return randomUUID().replaceAll('-', '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidRequest(message: string): DirectError {
  return new DirectError('direct_configuration_error', message)
}
