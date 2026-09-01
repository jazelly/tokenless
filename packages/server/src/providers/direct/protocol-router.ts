import { randomUUID } from 'node:crypto'

import type { DirectProviderConfig, ProviderBackend } from '../../persistence/config.js'
import type { G4fServiceClient } from './g4f/client.js'
import { assertProviderBackendAvailable, g4fProviderName } from './g4f-map.js'

export type DirectTextMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type DirectTextCompletion = {
  backend: ProviderBackend
  provider: string
  upstreamProvider: string
  text: string
  citations: { url: string; title?: string }[]
  requestId: string
  conversation: Record<string, unknown> | null
}

export type DirectG4fStreamEndpoint = 'chat' | 'responses'

export type DirectG4fImage = Readonly<{
  bytes: Buffer
  mediaType: string | null
}>

const MAX_DIRECT_IMAGE_BYTES = 32 * 1024 * 1024

export class ProviderProtocolRouter {
  constructor(private readonly g4fClient?: G4fServiceClient | undefined) {}

  backend(config: DirectProviderConfig, provider: string, requested?: ProviderBackend): ProviderBackend {
    const backend = requested ?? config.providerBackends[provider] ?? config.defaultBackend
    assertProviderBackendAvailable(provider, backend)
    return backend
  }

  async completeG4f({
    provider,
    messages,
    model = '',
    authContextId,
    signal,
    extra = {},
  }: {
    provider: string
    messages: readonly DirectTextMessage[]
    model?: string | undefined
    authContextId?: string | undefined
    signal?: AbortSignal | undefined
    extra?: Record<string, unknown> | undefined
  }): Promise<DirectTextCompletion> {
    if (!this.g4fClient) {
      const error = new Error('The private G4F service is not running.') as Error & { code?: string }
      error.code = 'g4f_service_unavailable'
      throw error
    }
    const upstreamProvider = g4fProviderName(provider)
    if (!upstreamProvider) assertProviderBackendAvailable(provider, 'g4f')
    const response = await this.g4fClient.request({
      path: `/api/${encodeURIComponent(upstreamProvider!)}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, provider: upstreamProvider, messages, stream: false, ...extra }),
      authContextId,
      signal,
    })
    const parsed = await parseG4fCompletionResponse(response)
    return {
      backend: 'g4f',
      provider,
      upstreamProvider: upstreamProvider!,
      text: parsed.text,
      citations: parsed.citations,
      requestId: parsed.id ?? randomUUID(),
      conversation: parsed.conversation,
    }
  }

  async streamG4f({
    provider,
    messages,
    model = '',
    authContextId,
    signal,
    endpoint = 'chat',
  }: {
    provider: string
    messages: readonly DirectTextMessage[]
    model?: string | undefined
    authContextId?: string | undefined
    signal?: AbortSignal | undefined
    endpoint?: DirectG4fStreamEndpoint | undefined
  }) {
    if (!this.g4fClient) {
      const error = new Error('The private G4F service is not running.') as Error & { code?: string }
      error.code = 'g4f_service_unavailable'
      throw error
    }
    const upstreamProvider = g4fProviderName(provider)
    if (!upstreamProvider) assertProviderBackendAvailable(provider, 'g4f')
    const path = endpoint === 'responses'
      ? `/api/${encodeURIComponent(upstreamProvider!)}/responses`
      : `/api/${encodeURIComponent(upstreamProvider!)}/chat/completions`
    const body = endpoint === 'responses'
      ? { model, provider: upstreamProvider, input: messages, stream: true }
      : { model, provider: upstreamProvider, messages, stream: true }
    return await this.g4fClient.request({
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(authContextId ? { authContextId } : {}),
      signal,
    })
  }

  async generateImageG4f({
    provider,
    prompt,
    model = 'gpt-image',
    authContextId,
    signal,
  }: {
    provider: string
    prompt: string
    model?: string | undefined
    authContextId?: string | undefined
    signal?: AbortSignal | undefined
  }): Promise<readonly DirectG4fImage[]> {
    if (!this.g4fClient) {
      const error = new Error('The private image service is not running.') as Error & { code?: string }
      error.code = 'image_service_unavailable'
      throw error
    }
    if (provider !== 'chatgpt') {
      const error = new Error('The selected provider does not support direct image generation.') as Error & { code?: string }
      error.code = 'direct_image_provider_unsupported'
      throw error
    }
    const response = await this.g4fClient.request({
      path: '/api/OpenaiChat/images/generations',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
      ...(authContextId ? { authContextId } : {}),
      signal,
    })
    const payload = await parseG4fImageResponse(response)
    const images: DirectG4fImage[] = []
    for (const item of payload) {
      const assetPath = privateImageAssetPath(item)
      const assetResponse = await this.g4fClient.rawRequest({ path: assetPath, signal })
      if (!assetResponse.ok) {
        const error = new Error('The private image service returned an unavailable image asset.') as Error & { code?: string }
        error.code = 'direct_image_asset_unavailable'
        throw error
      }
      const bytes = await readBoundedImage(assetResponse, signal)
      images.push({ bytes, mediaType: assetResponse.headers.get('content-type') })
    }
    if (images.length === 0) {
      const error = new Error('The private image service returned no image assets.') as Error & { code?: string }
      error.code = 'direct_image_result_empty'
      throw error
    }
    return images
  }
}

async function parseG4fImageResponse(response: Response): Promise<readonly string[]> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    const error = new Error('The private image service returned invalid image metadata.') as Error & { code?: string }
    error.code = 'direct_image_result_invalid'
    throw error
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw directImageResultInvalid()
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) throw directImageResultInvalid()
  const urls = data.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).url !== 'string') {
      throw directImageResultInvalid()
    }
    return (item as Record<string, unknown>).url as string
  })
  return urls
}

function privateImageAssetPath(value: string) {
  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    throw directImageResultInvalid()
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(candidate.hostname)) {
    throw directImageResultInvalid()
  }
  if (!/^\/(?:images|media)\/[^/]+$/u.test(candidate.pathname)) {
    throw directImageResultInvalid()
  }
  return `${candidate.pathname}${candidate.search}`
}

async function readBoundedImage(response: Response, signal?: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const bytes = Number(declaredLength)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_DIRECT_IMAGE_BYTES) {
      throw directImageTooLarge()
    }
  }
  if (!response.body) throw directImageResultInvalid()
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let byteLength = 0
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_DIRECT_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw directImageTooLarge()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, byteLength)
}

function directImageResultInvalid() {
  const error = new Error('The private image service returned an invalid image result.') as Error & { code?: string }
  error.code = 'direct_image_result_invalid'
  return error
}

function directImageTooLarge() {
  const error = new Error('The generated image exceeds the Tokenless asset size limit.') as Error & { code?: string }
  error.code = 'direct_image_result_too_large'
  return error
}

async function parseG4fCompletionResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    return parseG4fCompletion(await response.json() as unknown)
  }
  if (!response.body) throw invalidG4fResponse()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let text = ''
  let id: string | null = null
  let conversation: Record<string, unknown> | null = null
  const citationSources: Record<string, unknown>[] = []
  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let payload: unknown
    try {
      payload = JSON.parse(data) as unknown
    } catch {
      throw invalidG4fResponse()
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const record = payload as Record<string, unknown>
    if (record.error !== undefined) throw g4fStreamError(record.error)
    if (typeof record.id === 'string') id ??= record.id
    if (record.conversation && typeof record.conversation === 'object' && !Array.isArray(record.conversation)) {
      conversation = record.conversation as Record<string, unknown>
    }
    citationSources.push(record)
    const choices = Array.isArray(record.choices) ? record.choices : []
    const first = choices[0]
    if (!first || typeof first !== 'object' || Array.isArray(first)) return
    const choice = first as Record<string, unknown>
    const delta = choice.delta && typeof choice.delta === 'object' && !Array.isArray(choice.delta)
      ? choice.delta as Record<string, unknown>
      : null
    const message = choice.message && typeof choice.message === 'object' && !Array.isArray(choice.message)
      ? choice.message as Record<string, unknown>
      : null
    const chunkText = contentText(delta?.content ?? message?.content)
    if (chunkText) text += chunkText
    if (delta) citationSources.push(delta)
    if (message) citationSources.push(message)
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const lines = buffered.split(/\r?\n/u)
      buffered = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
    buffered += decoder.decode()
    for (const line of buffered.split(/\r?\n/u)) consumeLine(line)
  } finally {
    reader.releaseLock()
  }
  if (!text.trim()) throw invalidG4fResponse()
  return { text, citations: collectCitations(...citationSources), id, conversation }
}

function parseG4fCompletion(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidG4fResponse()
  const payload = value as Record<string, unknown>
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) throw invalidG4fResponse()
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalidG4fResponse()
  const text = contentText((message as Record<string, unknown>).content)
  if (!text.trim()) throw invalidG4fResponse()
  return {
    text,
    citations: collectCitations(payload, message as Record<string, unknown>),
    id: typeof payload.id === 'string' ? payload.id : null,
    conversation: payload.conversation && typeof payload.conversation === 'object' && !Array.isArray(payload.conversation)
      ? payload.conversation as Record<string, unknown>
      : null,
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    return typeof record.text === 'string' ? [record.text] : []
  }).join('\n')
}

function collectCitations(...sources: Record<string, unknown>[]) {
  const seen = new Set<string>()
  const citations: { url: string; title?: string }[] = []
  for (const source of sources) {
    const candidates = [source.citations, source.sources, source.web_results].flatMap((value) => Array.isArray(value) ? value : [])
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      const url = [record.url, record.href, record.link].find((item): item is string => typeof item === 'string' && /^https?:\/\//.test(item))
      if (!url || seen.has(url)) continue
      seen.add(url)
      const title = [record.title, record.label, record.name].find((item): item is string => typeof item === 'string' && item.length > 0)
      citations.push({ url, ...(title ? { title } : {}) })
    }
  }
  return citations
}

function invalidG4fResponse() {
  const error = new Error('The private G4F service returned an invalid completion response.') as Error & { code?: string }
  error.code = 'g4f_completion_invalid'
  return error
}

function g4fStreamError(value: unknown) {
  const message = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).message
    : null
  const upstreamType = typeof message === 'string' ? /^([A-Za-z][A-Za-z0-9_]*)/.exec(message)?.[1] : null
  const error = new Error('The private G4F service ended its response stream with a sanitized provider error.') as Error & { code?: string }
  error.code = upstreamType ? `g4f_stream_${upstreamType}` : 'g4f_stream_error'
  return error
}
