import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'

import { readTokenlessConfig } from '../job-store.js'
import { createManagedPlaywrightJobRequest, MANAGED_PLAYWRIGHT_JOB_ACTION } from '../playwright/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../playwright/actions.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import { getProviderInstanceById, type ProviderId } from '../providers/registry.js'
import {
  FEATUREBENCH_BENCHMARK_COMMIT,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_PROTOCOL,
  type FeatureBenchExecutionMode,
} from '../featurebench/constants.js'
import type { Job, JobStore } from './job-store.js'

const MAX_BRIDGE_BODY_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_PROMPT_BYTES = 900 * 1024
const DEFAULT_CHANNEL_LIFETIME_MS = 4 * 60 * 60_000
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 10 * 60_000
const MAX_BRIDGE_REQUEST_TIMEOUT_MS = 31 * 60_000
const JOB_POLL_INTERVAL_MS = 250

export type FeatureBenchChannelIssue = {
  instanceId: string
  benchmarkRunId: string
  benchmarkCommit: string
  datasetRevision: string
  provider: string
  profile?: string | undefined
  executionMode: FeatureBenchExecutionMode
  model: string
  effort?: string | undefined
  maxTurns: number
  expiresInMs?: number | undefined
  providerTurnTimeoutMs?: number | undefined
}

type ChannelRecord = {
  channelId: string
  tokenHash: Buffer
  instanceId: string
  benchmarkRunId: string
  provider: ProviderId
  profileId: string
  executionMode: FeatureBenchExecutionMode
  model: string
  effort: string | null
  taskId: string
  maxTurns: number
  turns: number
  expiresAtMs: number
  providerTurnTimeoutMs: number
  active: boolean
}

export class FeatureBenchChannelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly category: 'channel' | 'provider_turn' | 'action_validation',
    message: string,
  ) {
    super(message)
    this.name = 'FeatureBenchChannelError'
  }
}

export class FeatureBenchChannelManager {
  private readonly channels = new Map<string, ChannelRecord>()
  private readonly profiles: ManagedProfileRegistry
  private bridgeServer: http.Server | null = null
  private bridgePort: number | null = null
  private startingBridge: Promise<number> | null = null

  constructor(private readonly store: JobStore, private readonly wake: () => Promise<unknown>) {
    this.profiles = new ManagedProfileRegistry(store.homeDir)
  }

  async issue(input: FeatureBenchChannelIssue) {
    this.pruneExpired()
    const instanceId = boundedIdentifier(input.instanceId, 'instanceId', 512)
    const benchmarkRunId = boundedIdentifier(input.benchmarkRunId, 'benchmarkRunId', 256)
    if (input.benchmarkCommit !== FEATUREBENCH_BENCHMARK_COMMIT || input.datasetRevision !== FEATUREBENCH_DATASET_REVISION) {
      throw new FeatureBenchChannelError(409, 'featurebench_revision_mismatch', 'channel', 'FeatureBench revisions do not match the pinned Tokenless baseline.')
    }
    const provider = getProviderInstanceById(input.provider as ProviderId)
    if (!provider || provider.descriptor.stage === 'disabled') {
      throw new FeatureBenchChannelError(400, 'featurebench_provider_invalid', 'channel', 'FeatureBench provider is unavailable.')
    }
    const executionMode = executionModeValue(input.executionMode)
    if (executionMode === 'direct' && provider.id !== 'chatgpt' && provider.id !== 'perplexity') {
      throw new FeatureBenchChannelError(400, 'featurebench_direct_provider_unsupported', 'channel', 'Direct FeatureBench turns support only ChatGPT and Perplexity.')
    }
    const profile = await this.profiles.resolveProfile(input.profile)
    if (profile.lifecycle !== 'ready') {
      throw new FeatureBenchChannelError(503, 'featurebench_profile_not_ready', 'channel', 'The selected Tokenless profile is not ready.')
    }
    const config = await readTokenlessConfig(this.store.homeDir)
    const enabledProviders = config.profiles[profile.slug]?.enabledProviders ?? []
    if (!enabledProviders.includes(provider.id)) {
      throw new FeatureBenchChannelError(503, 'featurebench_provider_not_enabled', 'channel', 'The selected profile does not enable this FeatureBench provider.')
    }
    const model = boundedLabel(input.model, 'model', 256)
    const effort = input.effort === undefined ? null : boundedLabel(input.effort, 'effort', 128)
    if (executionMode === 'direct' && (model !== 'provider-default' || effort !== null)) {
      throw new FeatureBenchChannelError(400, 'featurebench_direct_controls_unsupported', 'action_validation', 'Direct FeatureBench mode requires model=provider-default and no effort override.')
    }
    const maxTurns = boundedInteger(input.maxTurns, 'maxTurns', 1, 200)
    const expiresInMs = boundedInteger(input.expiresInMs ?? DEFAULT_CHANNEL_LIFETIME_MS, 'expiresInMs', 60_000, 24 * 60 * 60_000)
    const providerTurnTimeoutMs = boundedInteger(
      input.providerTurnTimeoutMs ?? DEFAULT_PROVIDER_TURN_TIMEOUT_MS,
      'providerTurnTimeoutMs',
      30_000,
      30 * 60_000,
    )
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const channelId = `fbch_${randomUUID()}`
    const expiresAtMs = Date.now() + expiresInMs
    const taskId = `featurebench:${sha256(`${benchmarkRunId}\0${instanceId}`).slice(0, 40)}`
    const channel: ChannelRecord = {
      channelId,
      tokenHash,
      instanceId,
      benchmarkRunId,
      provider: provider.id,
      profileId: profile.id,
      executionMode,
      model,
      effort,
      taskId,
      maxTurns,
      turns: 0,
      expiresAtMs,
      providerTurnTimeoutMs,
      active: false,
    }
    this.channels.set(tokenHash.toString('hex'), channel)
    const bridgePort = await this.ensureBridge()
    return {
      protocol: FEATUREBENCH_PROTOCOL,
      channelId,
      token,
      bridgePort,
      instanceId,
      benchmarkCommit: FEATUREBENCH_BENCHMARK_COMMIT,
      datasetRevision: FEATUREBENCH_DATASET_REVISION,
      provider: provider.id,
      profileId: profile.id,
      model,
      executionMode,
      maxTurns,
      providerTurnTimeoutMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  async close() {
    this.channels.clear()
    const server = this.bridgeServer
    this.bridgeServer = null
    this.bridgePort = null
    this.startingBridge = null
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  private async ensureBridge() {
    if (this.bridgePort !== null) return this.bridgePort
    this.startingBridge ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleBridgeRequest(request, response)
      })
      server.requestTimeout = MAX_BRIDGE_REQUEST_TIMEOUT_MS
      server.timeout = MAX_BRIDGE_REQUEST_TIMEOUT_MS
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('FeatureBench bridge did not receive a TCP port.'))
          return
        }
        this.bridgeServer = server
        this.bridgePort = address.port
        resolve(address.port)
      })
    })
    try {
      return await this.startingBridge
    } finally {
      this.startingBridge = null
    }
  }

  private async handleBridgeRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      this.pruneExpired()
      const method = request.method ?? 'GET'
      const pathname = new URL(request.url ?? '/', 'http://featurebench.local').pathname
      const channel = this.authorize(request)
      if (method === 'POST' && pathname === '/v1/featurebench/turn') {
        const body = await readJsonObject(request)
        writeJson(response, 200, await this.turn(channel, body))
        return
      }
      if (method === 'POST' && pathname === '/v1/featurebench/turn/complete') {
        this.channels.delete(channel.tokenHash.toString('hex'))
        writeJson(response, 200, { protocol: FEATUREBENCH_PROTOCOL, completed: true })
        return
      }
      throw new FeatureBenchChannelError(404, 'featurebench_channel_route_not_found', 'channel', 'FeatureBench channel route was not found.')
    } catch (error) {
      const failure = publicChannelError(error)
      writeJson(response, failure.status, { error: { code: failure.code, category: failure.category, message: failure.message } })
    }
  }

  private authorize(request: IncomingMessage) {
    const header = request.headers.authorization
    const value = Array.isArray(header) ? header[0] : header
    if (!value?.startsWith('Bearer ')) {
      throw new FeatureBenchChannelError(401, 'featurebench_channel_auth_rejected', 'channel', 'FeatureBench channel authorization was rejected.')
    }
    const presented = hashToken(value.slice('Bearer '.length))
    const channel = this.channels.get(presented.toString('hex'))
    if (!channel || !timingSafeEqual(presented, channel.tokenHash) || channel.expiresAtMs <= Date.now()) {
      throw new FeatureBenchChannelError(401, 'featurebench_channel_auth_rejected', 'channel', 'FeatureBench channel authorization was rejected.')
    }
    return channel
  }

  private async turn(channel: ChannelRecord, body: Record<string, unknown>) {
    if (channel.active) {
      throw new FeatureBenchChannelError(409, 'featurebench_channel_turn_active', 'channel', 'A FeatureBench provider turn is already active.')
    }
    if (body.protocol !== FEATUREBENCH_PROTOCOL) {
      throw new FeatureBenchChannelError(400, 'featurebench_channel_protocol_invalid', 'channel', 'FeatureBench channel protocol is invalid.')
    }
    const expectedTurn = channel.turns + 1
    const turn = boundedInteger(body.turn, 'turn', 1, channel.maxTurns)
    if (turn !== expectedTurn) {
      throw new FeatureBenchChannelError(409, 'featurebench_channel_turn_out_of_order', 'channel', `FeatureBench expected turn ${expectedTurn}.`)
    }
    const prompt = boundedPrompt(body.prompt, 'prompt')
    const replayPrompt = boundedPrompt(body.replayPrompt, 'replayPrompt')
    channel.turns = turn
    channel.active = true
    try {
      const completion = await this.completeProviderTurn(channel, turn, prompt, replayPrompt)
      return {
        protocol: FEATUREBENCH_PROTOCOL,
        turn,
        text: completion.text,
        citations: completion.citations,
        jobId: completion.jobId,
      }
    } finally {
      channel.active = false
    }
  }

  private async completeProviderTurn(channel: ChannelRecord, turn: number, prompt: string, replayPrompt: string) {
    const provider = getProviderInstanceById(channel.provider)
    if (!provider) throw new FeatureBenchChannelError(503, 'featurebench_provider_unavailable', 'provider_turn', 'FeatureBench provider is unavailable.')
    const mapping = channel.executionMode === 'browser'
      ? this.store.resolveProviderTaskConversation({ provider: channel.provider, profile_id: channel.profileId, task_id: channel.taskId })
      : null
    const resumesConversation = Boolean(mapping?.canonical_url)
    const actualPrompt = channel.executionMode === 'direct' || !resumesConversation ? replayPrompt : prompt
    const actions = []
    if (channel.executionMode === 'browser' && !resumesConversation && channel.model !== 'provider-default') {
      actions.push(createVisibleActionRequest({ provider: channel.provider, action: VISIBLE_ACTIONS.MODEL_SELECT, payload: { label: channel.model } }))
    }
    if (channel.executionMode === 'browser' && !resumesConversation && channel.effort) {
      actions.push(createVisibleActionRequest({ provider: channel.provider, action: VISIBLE_ACTIONS.EFFORT_SELECT, payload: { label: channel.effort } }))
    }
    actions.push(
      createVisibleActionRequest({ provider: channel.provider, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: actualPrompt } }),
      createVisibleActionRequest({ provider: channel.provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
      createVisibleActionRequest({ provider: channel.provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
    )
    let requestJson
    try {
      requestJson = createManagedPlaywrightJobRequest({
        provider: channel.provider,
        target: { kind: 'provider_home', url: mapping?.canonical_url ?? provider.descriptor.navigation.homeUrl },
        taskId: channel.executionMode === 'browser' ? channel.taskId : null,
        pageRef: channel.executionMode === 'browser' ? channel.channelId : null,
        pagePolicy: channel.executionMode === 'browser' && !resumesConversation ? 'replace' : 'preserve',
        executionMode: channel.executionMode,
        browserVisibility: 'auto',
        userHandoff: false,
        actions,
      })
    } catch {
      throw new FeatureBenchChannelError(400, 'featurebench_provider_action_invalid', 'action_validation', 'FeatureBench provider controls or actions are unavailable for the selected route.')
    }
    const job = this.store.createJob({
      provider: channel.provider,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: requestJson,
      execution_backend: 'playwright',
      profile_id: channel.profileId,
      agent_kind: 'featurebench',
      agent_session_id: channel.channelId,
    })
    await this.wake()
    const settled = await this.awaitTerminalJob(job.job_id, channel.providerTurnTimeoutMs)
    const visible = visibleResponse(settled.result_json)
    if (settled.status !== 'succeeded' || !visible) {
      throw new FeatureBenchChannelError(502, 'featurebench_provider_turn_failed', 'provider_turn', `FeatureBench provider turn ${turn} did not produce a visible response.`)
    }
    return { ...visible, jobId: settled.job_id }
  }

  private async awaitTerminalJob(jobId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = this.store.getJob(jobId)
      if (isTerminal(job.status)) return job
      if (job.status === 'waiting_for_user') {
        await this.cancelChannelJob(jobId, 'featurebench_provider_user_handoff')
        throw new FeatureBenchChannelError(502, 'featurebench_provider_user_handoff', 'provider_turn', 'FeatureBench provider turn requires user handoff.')
      }
      if (Date.now() >= deadline) {
        const canceled = await this.cancelChannelJob(jobId, 'featurebench_provider_turn_timeout')
        if (canceled.status !== 'canceled') return canceled
        throw new FeatureBenchChannelError(504, 'featurebench_provider_turn_timeout', 'provider_turn', 'FeatureBench provider turn timed out.')
      }
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
    }
  }

  private async cancelChannelJob(jobId: string, code: string) {
    try {
      return await this.store.cancelJob(jobId, { code })
    } catch {
      const job = this.store.getJob(jobId)
      if (isTerminal(job.status)) return job
      throw new FeatureBenchChannelError(
        500,
        'featurebench_provider_cancel_failed',
        'provider_turn',
        'FeatureBench could not cancel an abandoned provider job.',
      )
    }
  }

  private pruneExpired() {
    const now = Date.now()
    for (const [key, channel] of this.channels) {
      if (channel.expiresAtMs <= now) this.channels.delete(key)
    }
  }
}

function visibleResponse(value: unknown): { text: string; citations: Array<{ url: string; title?: string }> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return null
  for (const entry of responses) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { action?: unknown; result?: unknown }
    if (record.action !== VISIBLE_ACTIONS.RESPONSE_READ || !record.result || typeof record.result !== 'object') continue
    const result = record.result as { text?: unknown; citations?: unknown }
    if (typeof result.text !== 'string' || !result.text.trim()) continue
    const citations = Array.isArray(result.citations)
      ? result.citations.flatMap((citation: unknown) => {
          if (!citation || typeof citation !== 'object') return []
          const source = citation as { href?: unknown; label?: unknown; url?: unknown; title?: unknown }
          const url = typeof source.href === 'string' ? source.href : typeof source.url === 'string' ? source.url : null
          if (!url || !/^https?:\/\//.test(url)) return []
          const title = typeof source.label === 'string' ? source.label : typeof source.title === 'string' ? source.title : null
          return [{ url, ...(title ? { title } : {}) }]
        })
      : []
    return { text: result.text, citations }
  }
  return null
}

async function readJsonObject(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BRIDGE_BODY_BYTES) throw new FeatureBenchChannelError(413, 'featurebench_channel_body_too_large', 'channel', 'FeatureBench channel request is too large.')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new FeatureBenchChannelError(400, 'featurebench_channel_json_invalid', 'channel', 'FeatureBench channel request must be a JSON object.')
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function publicChannelError(error: unknown) {
  if (error instanceof FeatureBenchChannelError) return error
  return new FeatureBenchChannelError(500, 'featurebench_channel_failed', 'channel', 'The local FeatureBench channel encountered an error.')
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest()
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function boundedIdentifier(value: unknown, field: string, maxBytes: number) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f]/.test(value)) {
    throw new FeatureBenchChannelError(400, `featurebench_${field}_invalid`, 'channel', `${field} is invalid.`)
  }
  return value
}

function boundedLabel(value: unknown, field: string, maxBytes: number) {
  return boundedIdentifier(value, field, maxBytes)
}

function boundedPrompt(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > MAX_PROVIDER_PROMPT_BYTES) {
    throw new FeatureBenchChannelError(400, `featurebench_${field}_invalid`, 'channel', `${field} is empty or too large.`)
  }
  return value
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new FeatureBenchChannelError(400, `featurebench_${field}_invalid`, 'channel', `${field} must be an integer from ${min} through ${max}.`)
  }
  return Number(value)
}

function executionModeValue(value: unknown): FeatureBenchExecutionMode {
  if (value !== 'browser' && value !== 'direct') {
    throw new FeatureBenchChannelError(400, 'featurebench_execution_mode_invalid', 'channel', 'FeatureBench execution mode must be browser or direct.')
  }
  return value
}

function isTerminal(status: Job['status']) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'timed_out'
}
