import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { G4fServiceClient } from '../g4f/client.js'
import { readTokenlessConfig } from '../job-store.js'
import {
  MAX_IMAGE_ASSET_BYTES,
  persistDirectImageAsset,
  type PersistedImageAsset,
} from '../playwright/image-assets.js'
import { createVisibleActionRequest, VISIBLE_ACTIONS } from '../playwright/actions.js'
import { createE2EInspectionJobId } from '../playwright/e2e-inspection.js'
import {
  createManagedPlaywrightJobRequest,
  MANAGED_PLAYWRIGHT_JOB_ACTION,
} from '../playwright/job-contract.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import {
  getProviderInstanceById,
  resolveTaskCapabilityRoutes,
  TASK_CAPABILITIES,
  type ProviderId,
  type TaskCapabilityRoute,
} from '../providers/registry.js'
import type { Job, JobStore } from './job-store.js'

const MODEL_PREFIX = 'tokenless/'
const POLLINATIONS_PROVIDER = 'pollinations'
const POLLINATIONS_UPSTREAM_PROVIDER = 'PollinationsImage'
const POLLINATIONS_MODEL = 'sana'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const POLL_INTERVAL_MS = 250
const SAFE_ASSET_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const IMAGE_REQUIREMENTS = Object.freeze([
  TASK_CAPABILITIES.IMAGE_GENERATION,
  TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
])

type ImageExecutionMode = 'browser' | 'direct'

type ImageGenerationRequest = Readonly<{
  provider: 'auto' | ProviderId | typeof POLLINATIONS_PROVIDER
  providerModel: string
  prompt: string
  executionMode: ImageExecutionMode
  profile: string | undefined
  taskId: string
  pageRef: string | undefined
  browserVisibility: 'auto' | 'headed' | 'headless' | undefined
  timeoutMs: number
  size: '768x768' | undefined
}>

export type ImageGenerationResponse = Readonly<{
  created: number
  data: readonly Readonly<{
    url: string
    asset: PersistedImageAsset
  }>[]
  tokenless: Readonly<{
    provider: string
    execution_mode: ImageExecutionMode
    request_id: string
    task_id: string
    job_id: string | null
    capability_route: TaskCapabilityRoute | null
  }>
}>

export class ImageGenerationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

export class ImageGenerationAdapter {
  private readonly profiles: ManagedProfileRegistry

  constructor(
    private readonly store: JobStore,
    private readonly wake: () => Promise<unknown>,
    private readonly g4fClient?: G4fServiceClient | undefined,
  ) {
    this.profiles = new ManagedProfileRegistry(store.homeDir)
  }

  async generate(body: unknown): Promise<ImageGenerationResponse> {
    const request = normalizeImageGenerationRequest(body)
    return request.executionMode === 'browser'
      ? await this.generateBrowser(request)
      : await this.generateDirect(request)
  }

  private async generateBrowser(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    if (request.provider === POLLINATIONS_PROVIDER) {
      throw imageError(400, 'image_provider_mode_mismatch', 'The pollinations image provider is available only in direct mode.')
    }
    if (request.providerModel) {
      throw imageError(400, 'image_model_unsupported', 'Browser image generation does not accept a provider model suffix.')
    }
    if (request.size !== undefined) {
      throw imageError(400, 'image_size_unsupported', 'Browser image generation uses the provider-native image size.')
    }

    const [config, profile] = await Promise.all([
      readTokenlessConfig(this.store.homeDir),
      this.profiles.resolveProfile(request.profile),
    ])
    if (profile.lifecycle !== 'ready') {
      throw imageError(503, 'image_profile_not_ready', 'The managed profile is not ready; run tokenless setup first.', true)
    }
    const profileConfig = config.profiles[profile.slug]
    if (!profileConfig) {
      throw imageError(409, 'image_profile_not_configured', `Managed profile '${profile.slug}' has no configuration.`)
    }
    const explicitProvider = request.provider === 'auto' ? null : request.provider
    if (explicitProvider && !profileConfig.enabledProviders.includes(explicitProvider)) {
      throw imageError(409, 'image_provider_not_enabled', `Provider '${explicitProvider}' is not enabled for profile '${profile.slug}'.`)
    }

    const candidates = explicitProvider
      ? [{ provider: explicitProvider, runtimeEligibility: 'unchecked' as const }]
      : profileConfig.enabledProviders.flatMap((provider, preferenceRank) => {
          const instance = getProviderInstanceById(provider)
          if (!instance || instance.descriptor.stage === 'disabled') return []
          const observed = profile.lastObservedAuth[instance.id]
          const access = observed?.access ?? (observed?.auth === 'authenticated' ? 'signed_in_unknown' : 'unknown')
          const usable = access === 'guest' || access.startsWith('signed_in_')
          return [{
            provider: instance.id,
            runtimeEligibility: usable ? 'eligible' as const : 'ineligible' as const,
            reason: usable ? null : `provider_access_${access}`,
            preferenceRank,
          }]
        })
    const decision = resolveTaskCapabilityRoutes({ requirements: IMAGE_REQUIREMENTS, candidates })
    if (!decision.ok) {
      throw imageError(
        503,
        'image_route_unavailable',
        'No enabled provider can complete image generation and authenticated asset download for this request.',
        true,
        { evaluated: decision.evaluated },
      )
    }

    const primary = decision.routes[0]!
    const provider = primary.provider
    const actions = browserImageActions(provider, request.prompt)
    const jobId = createE2EInspectionJobId() ?? `tlp_${randomUUID()}`
    const jobRequest = createManagedPlaywrightJobRequest({
      provider,
      taskId: request.taskId,
      ...(request.pageRef === undefined ? {} : { pageRef: request.pageRef }),
      capabilityRoute: primary,
      fallback: null,
      browserVisibility: request.browserVisibility ?? profileConfig.browserVisibility,
      executionMode: 'browser',
      actions,
    })
    const job = this.store.createJob({
      provider,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: jobRequest,
      execution_backend: 'playwright',
      profile_id: profile.id,
      job_id: jobId,
    })
    await this.wake()
    const settled = await this.awaitTerminalJob(job.job_id, request.timeoutMs)
    if (settled.status !== 'succeeded') throw imageJobFailure(settled)
    const artifacts = responseArtifacts(settled.result_json)
    if (artifacts.length === 0) {
      throw imageError(502, 'image_result_invalid', 'The provider job completed without a persisted image asset.', true)
    }
    return imageResponse({
      provider: settled.provider,
      executionMode: 'browser',
      requestId: jobId,
      taskId: request.taskId,
      jobId,
      capabilityRoute: resolvedCapabilityRoute(settled, primary),
      artifacts,
    })
  }

  private async generateDirect(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    if (request.provider !== 'auto' && request.provider !== POLLINATIONS_PROVIDER) {
      throw imageError(400, 'image_provider_mode_mismatch', 'Direct image generation supports tokenless/auto or tokenless/pollinations.')
    }
    if (request.providerModel && request.providerModel !== POLLINATIONS_MODEL) {
      throw imageError(400, 'image_model_unsupported', `Direct image generation currently supports only ${POLLINATIONS_MODEL}.`)
    }
    if (!this.g4fClient) {
      throw imageError(503, 'image_direct_unavailable', 'The private direct image service is not running.', true)
    }
    const requestId = `tli_${randomUUID()}`
    const conversationId = `pollinations-${POLLINATIONS_MODEL}-${randomUUID()}`
    const [width, height] = (request.size ?? '768x768').split('x').map(Number) as [number, number]
    const signal = AbortSignal.timeout(request.timeoutMs)
    try {
      const upstream = await this.g4fClient.rawRequest({
        path: `/api/${POLLINATIONS_UPSTREAM_PROVIDER}/images/generations`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.providerModel || POLLINATIONS_MODEL,
          prompt: request.prompt,
          width,
          height,
        }),
        signal,
      })
      if (!upstream.ok) {
        throw imageError(502, 'image_provider_error', 'The direct image provider rejected the generation request.', true)
      }
      let payload: Record<string, unknown>
      try {
        const decoded = await upstream.json() as unknown
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new TypeError('Direct image response must be an object.')
        }
        payload = decoded as Record<string, unknown>
      } catch (error) {
        if (signal.aborted) throw directImageTimeout(requestId, request.timeoutMs)
        throw imageError(502, 'image_result_invalid', 'The direct image provider returned invalid JSON.', true)
      }
      if (!Array.isArray(payload.data) || payload.data.length === 0) {
        throw imageError(502, 'image_result_invalid', 'The direct image provider returned no downloadable image data.', true)
      }
      const artifacts: PersistedImageAsset[] = []
      for (const [index, item] of payload.data.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).url !== 'string') {
          throw imageError(502, 'image_result_invalid', 'The direct image provider returned an invalid image result.', true)
        }
        const assetPath = privateAssetPath((item as Record<string, unknown>).url as string)
        const assetResponse = await this.g4fClient.rawRequest({ path: assetPath, signal })
        if (!assetResponse.ok) {
          throw imageError(502, 'image_asset_download_failed', 'The direct image bytes could not be downloaded.', true)
        }
        const bytes = await readBoundedDirectImage(assetResponse, signal)
        artifacts.push(await persistDirectImageAsset(bytes, {
          assetRoot: path.join(this.store.homeDir, 'assets'),
          jobId: requestId,
          taskId: request.taskId,
          conversationId,
          signal,
        }, index))
      }
      return imageResponse({
        provider: POLLINATIONS_PROVIDER,
        executionMode: 'direct',
        requestId,
        taskId: request.taskId,
        jobId: null,
        capabilityRoute: null,
        artifacts,
      })
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error
      if (signal.aborted) throw directImageTimeout(requestId, request.timeoutMs)
      throw imageError(502, 'image_provider_error', 'The direct image provider request failed.', true)
    }
  }

  private async awaitTerminalJob(jobId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = this.store.getJob(jobId)
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled' || job.status === 'timed_out') return job
      if (job.status === 'waiting_for_user') throw imageJobFailure(job)
      if (Date.now() >= deadline) {
        throw imageError(504, 'image_generation_timeout', `Image generation did not complete within ${Math.round(timeoutMs / 1000)} seconds.`, true, { job_id: jobId })
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }
}

function normalizeImageGenerationRequest(value: unknown): ImageGenerationRequest {
  const body = plainRecord(value, 'Image generation request body must be a JSON object.')
  exactKeys(body, ['model', 'prompt'], ['size', 'tokenless'], 'image generation request')
  const model = imageModel(body.model)
  const prompt = requiredText(body.prompt, 'prompt', 1_048_576)
  const options = body.tokenless === undefined
    ? {}
    : plainRecord(body.tokenless, 'tokenless must be a JSON object.')
  exactKeys(options, ['execution_mode'], ['profile', 'task_id', 'page_ref', 'browser_visibility', 'timeout_ms'], 'tokenless')
  const executionMode = options.execution_mode
  if (executionMode !== 'browser' && executionMode !== 'direct') {
    throw imageError(400, 'image_execution_mode_invalid', 'tokenless.execution_mode must be browser or direct.')
  }
  const profile = optionalText(options.profile, 'tokenless.profile', 128)
  const taskId = options.task_id === undefined
    ? `image-${randomUUID()}`
    : safeAssetText(options.task_id, 'tokenless.task_id')
  const pageRef = optionalText(options.page_ref, 'tokenless.page_ref', 256)
  const browserVisibility = options.browser_visibility
  if (browserVisibility !== undefined && browserVisibility !== 'auto' && browserVisibility !== 'headed' && browserVisibility !== 'headless') {
    throw imageError(400, 'image_browser_visibility_invalid', 'tokenless.browser_visibility must be auto, headed, or headless.')
  }
  const timeoutMs = optionalPositiveInteger(options.timeout_ms, 'tokenless.timeout_ms', DEFAULT_TIMEOUT_MS, 15 * 60_000)
  const size = body.size
  if (size !== undefined && size !== '768x768') {
    throw imageError(400, 'image_size_unsupported', 'size currently supports only 768x768.')
  }
  return Object.freeze({
    provider: model.provider,
    providerModel: model.providerModel,
    prompt,
    executionMode,
    profile,
    taskId,
    pageRef,
    browserVisibility,
    timeoutMs,
    size,
  })
}

function imageModel(value: unknown) {
  if (typeof value !== 'string' || !value.trim().startsWith(MODEL_PREFIX)) {
    throw imageError(400, 'image_model_invalid', `model must be named ${MODEL_PREFIX}auto or ${MODEL_PREFIX}<provider>.`)
  }
  const requestedModel = value.trim()
  const [provider = '', ...modelParts] = requestedModel.slice(MODEL_PREFIX.length).split('/')
  if (!/^[a-z0-9-]{1,64}$/u.test(provider)) {
    throw imageError(404, 'image_model_not_found', `The image model '${requestedModel}' does not exist.`)
  }
  if (provider !== 'auto' && provider !== POLLINATIONS_PROVIDER && !getProviderInstanceById(provider)) {
    throw imageError(404, 'image_model_not_found', `The image model '${requestedModel}' does not exist.`)
  }
  if (provider === 'auto' && modelParts.length > 0) {
    throw imageError(404, 'image_model_not_found', `The image model '${requestedModel}' does not exist.`)
  }
  return {
    provider: provider as ImageGenerationRequest['provider'],
    providerModel: modelParts.join('/'),
  }
}

function browserImageActions(provider: ProviderId, prompt: string) {
  const actions = []
  if (provider === 'arena') {
    actions.push(createVisibleActionRequest({
      provider,
      action: VISIBLE_ACTIONS.ARENA_SURFACE_SELECT,
      payload: { mode: 'direct', modality: 'image' },
    }))
  }
  if (provider === 'grok') {
    actions.push(createVisibleActionRequest({
      provider,
      action: VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
      payload: { modality: 'image' },
    }))
  }
  if (provider === 'gemini') {
    actions.push(createVisibleActionRequest({
      provider,
      action: VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
      payload: { modality: 'image' },
    }))
  }
  if (provider === 'dola') {
    actions.push(createVisibleActionRequest({
      provider,
      action: VISIBLE_ACTIONS.DOLA_IMAGE_SELECT,
      payload: { modality: 'image' },
    }))
  }
  if (provider === 'doubao') {
    actions.push(createVisibleActionRequest({
      provider,
      action: VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT,
      payload: { skill: 'image-generation' },
    }))
  }
  actions.push(
    createVisibleActionRequest({ provider, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: prompt } }),
    createVisibleActionRequest({ provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
    createVisibleActionRequest({ provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
  )
  return actions
}

function responseArtifacts(value: unknown): PersistedImageAsset[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return []
  for (const entry of [...responses].reverse()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (record.action !== VISIBLE_ACTIONS.RESPONSE_READ || !record.result || typeof record.result !== 'object' || Array.isArray(record.result)) continue
    const artifacts = (record.result as { artifacts?: unknown }).artifacts
    if (Array.isArray(artifacts)) return artifacts as PersistedImageAsset[]
  }
  return []
}

function resolvedCapabilityRoute(job: Job, fallback: TaskCapabilityRoute) {
  if (!job.request_json || typeof job.request_json !== 'object' || Array.isArray(job.request_json)) return fallback
  const route = (job.request_json as { capabilityRoute?: unknown }).capabilityRoute
  return route && typeof route === 'object' && !Array.isArray(route) ? route as TaskCapabilityRoute : fallback
}

function imageResponse(options: {
  provider: string
  executionMode: ImageExecutionMode
  requestId: string
  taskId: string
  jobId: string | null
  capabilityRoute: TaskCapabilityRoute | null
  artifacts: readonly PersistedImageAsset[]
}): ImageGenerationResponse {
  return Object.freeze({
    created: Math.floor(Date.now() / 1000),
    data: Object.freeze(options.artifacts.map((asset) => Object.freeze({
      url: `/v1/asset/${asset.assetRef.slice('assets/'.length)}`,
      asset,
    }))),
    tokenless: Object.freeze({
      provider: options.provider,
      execution_mode: options.executionMode,
      request_id: options.requestId,
      task_id: options.taskId,
      job_id: options.jobId,
      capability_route: options.capabilityRoute,
    }),
  })
}

function privateAssetPath(value: string) {
  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    throw imageError(502, 'image_result_invalid', 'The direct image provider returned a non-URL image result.', true)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(candidate.hostname)) {
    throw imageError(502, 'image_result_invalid', 'The direct image provider returned an image outside the private service.', true)
  }
  if (!/^\/(?:images|media)\/[^/]+$/u.test(candidate.pathname)) {
    throw imageError(502, 'image_result_invalid', 'The direct image provider returned an unsupported private asset path.', true)
  }
  return `${candidate.pathname}${candidate.search}`
}

async function readBoundedDirectImage(response: Response, signal: AbortSignal) {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const bytes = Number(declaredLength)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_IMAGE_ASSET_BYTES) {
      throw imageError(502, 'image_result_too_large', 'The generated image exceeds the Tokenless asset size limit.')
    }
  }
  if (!response.body) {
    throw imageError(502, 'image_asset_download_failed', 'The direct image response did not include bytes.', true)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  for (;;) {
    if (signal.aborted) throw signal.reason
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    if (byteLength > MAX_IMAGE_ASSET_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw imageError(502, 'image_result_too_large', 'The generated image exceeds the Tokenless asset size limit.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength)
}

function directImageTimeout(requestId: string, timeoutMs: number) {
  return imageError(
    504,
    'image_generation_timeout',
    `Image generation did not complete within ${Math.round(timeoutMs / 1000)} seconds.`,
    true,
    { request_id: requestId },
  )
}

function imageJobFailure(job: Job) {
  const source = job.blocker_json ?? job.error_json
  const detail = source && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : null
  return imageError(
    job.status === 'waiting_for_user' ? 409 : 502,
    job.status === 'waiting_for_user' ? 'image_user_action_required' : 'image_provider_job_failed',
    job.status === 'waiting_for_user'
      ? 'Image generation requires user action in the selected browser.'
      : 'The browser image provider job did not complete successfully.',
    job.status !== 'waiting_for_user',
    { job_id: job.job_id, provider: job.provider, status: job.status, issue: detail },
  )
}

function imageError(status: number, code: string, message: string, retryable = false, details?: unknown) {
  return new ImageGenerationError(status, code, message, retryable, details)
}

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw imageError(400, 'image_request_invalid', message)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string) {
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw imageError(400, 'image_request_invalid', `${label} contains unsupported field '${unknown}'.`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw imageError(400, 'image_request_invalid', `${label} is missing required field '${missing}'.`)
}

function requiredText(value: unknown, field: string, maxBytes: number) {
  if (typeof value !== 'string' || !value.trim()) throw imageError(400, 'image_request_invalid', `${field} must be a non-empty string.`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw imageError(400, 'image_request_invalid', `${field} is too large.`)
  return value
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw imageError(400, 'image_request_invalid', `${field} must be a non-empty string of at most ${maxLength} characters.`)
  }
  return value.trim()
}

function safeAssetText(value: unknown, field: string) {
  if (typeof value !== 'string' || !SAFE_ASSET_COMPONENT.test(value.trim())) {
    throw imageError(400, 'image_request_invalid', `${field} must be a safe non-empty asset identifier.`)
  }
  return value.trim()
}

function optionalPositiveInteger(value: unknown, field: string, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw imageError(400, 'image_request_invalid', `${field} must be an integer between 1 and ${maximum}.`)
  }
  return Number(value)
}
