import { createHash, randomBytes } from 'node:crypto'

import {
  HARNESS_RUN_PROTOCOL,
  PROVIDER_TURN_PROTOCOL,
  WEB_AGENT_PROTOCOL,
  HarnessSkillError,
  type AgentRunIntervention,
  type AgentRunSpec,
  type AgentRunView,
  type HarnessActionBatch,
  type HarnessActionBatchResult,
  type HarnessToolCatalogEntry,
  type HarnessToolRegistry,
  type JsonValue,
  type ProviderTurnClient,
  type ProviderTurnRequest,
  type WebAgentHarness,
} from './contracts.js'
import { canonicalJson } from './internal/filesystem.js'
import {
  HarnessRunStore,
  type DurableCall,
  type HarnessRunRecord,
} from './internal/run-store.js'

export async function openWebAgentHarness(input: {
  tokenlessHome: string
  providerClient: ProviderTurnClient
  toolRegistry: HarnessToolRegistry
}): Promise<WebAgentHarness> {
  return new DurableWebAgentHarness(
    await HarnessRunStore.open(input.tokenlessHome),
    input.providerClient,
    input.toolRegistry,
  )
}

class DurableWebAgentHarness implements WebAgentHarness {
  constructor(
    private readonly store: HarnessRunStore,
    private readonly provider: ProviderTurnClient,
    private readonly tools: HarnessToolRegistry,
  ) {}

  async start(input: AgentRunSpec): Promise<AgentRunView> {
    const spec = validateSpec(input)
    const runId = opaqueRef('run')
    const now = new Date().toISOString()
    let record = this.store.create({
      protocol: HARNESS_RUN_PROTOCOL,
      runId,
      revision: 0,
      status: 'discovering_tools',
      spec,
      turn: 1,
      nonce: opaqueRef('nonce'),
      requestRef: opaqueRef('request'),
      catalog: [],
      calls: [],
      needs: [],
      callResults: [],
      needResults: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    })
    try {
      const catalog = await this.tools.catalog(spec.mcpServers ?? [])
      record = this.store.update(runId, record.revision, (current) => ({ ...current, catalog }))
      const pendingProviderRequest = providerRequest(record)
      record = this.store.update(runId, record.revision, (current) => ({
        ...current,
        status: 'submitting_provider',
        pendingProviderRequest,
      }))
      record = await this.submitPending(record)
      return publicView(record)
    } catch (error) {
      record = this.fail(record, error)
      return publicView(record)
    }
  }

  async read(runId: string): Promise<AgentRunView | null> {
    let record = this.store.read(runId)
    if (!record) return null
    if (record.status === 'submitting_provider') return publicView(await this.submitPending(record))
    if (record.status !== 'running' || !record.providerTurn) return publicView(record)
    try {
      const providerTurn = await this.provider.read({
        runId,
        turn: record.turn,
        nonce: record.nonce,
        stagingRoot: record.spec.stagingRoot,
        turnRef: record.providerTurn.turnRef,
      })
      record = this.store.update(runId, record.revision, (current) => ({
        ...current,
        status: providerStatus(providerTurn.lifecycle),
        providerTurn,
      }))
      if (providerTurn.lifecycle !== 'succeeded') return publicView(record)
      return publicView(await this.acceptProviderResponse(record))
    } catch (error) {
      if (isRecoverableInterventionError(error)) throw error
      return publicView(this.fail(record, error))
    }
  }

  async resume(runId: string, intervention: AgentRunIntervention): Promise<AgentRunView> {
    let record = this.required(runId)
    try {
      if (record.status === 'waiting_for_approval') {
        const approvals = new Map((intervention.approvals ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.approval !== 'pending') return call
          if (approvals.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_approval_invalid', `Approval for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, approval: 'approved' as const }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', calls }))
      } else if (record.status === 'waiting_for_input') {
        const answers = intervention.answers ?? {}
        const needs = record.needs.map((need) => {
          if (!Object.hasOwn(answers, need.id)) throw new HarnessSkillError('harness_input_missing', `Answer for need '${need.id}' is required.`)
          return { ...need, answer: answers[need.id]! }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', needs }))
      } else if (record.status === 'waiting_for_authentication') {
        const completed = new Map((intervention.authenticationCompleted ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.status !== 'authentication_required') return call
          if (completed.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_auth_resume_invalid', `Authentication resume for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, status: 'pending' as const, handoff: undefined }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', calls }))
      } else {
        throw new HarnessSkillError('harness_run_not_resumable', 'Harness run is not waiting for a supported intervention.')
      }
      return publicView(await this.executeAndContinue(record))
    } catch (error) {
      return publicView(this.fail(record, error))
    }
  }

  async cancel(runId: string): Promise<AgentRunView> {
    let record = this.required(runId)
    if (isTerminal(record.status)) return publicView(record)
    try {
      if (record.providerTurn && ['queued', 'running', 'waiting_for_user'].includes(record.providerTurn.lifecycle)) {
        const providerTurn = await this.provider.cancel(record.providerTurn.turnRef)
        record = this.store.update(runId, record.revision, (current) => ({ ...current, providerTurn, status: 'cancelled' }))
      } else {
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'cancelled' }))
      }
      return publicView(record)
    } catch (error) {
      return publicView(this.fail(record, error))
    }
  }

  close() { this.store.close() }

  private async acceptProviderResponse(record: HarnessRunRecord) {
    const response = record.providerTurn?.modelResponse
    if (!response) throw new HarnessSkillError('harness_provider_response_missing', 'Provider turn succeeded without a validated Harness response.')
    if (response.kind === 'final') {
      return this.store.update(record.runId, record.revision, (current) => ({ ...current, status: 'succeeded', final: response }))
    }
    if (response.turn !== record.turn) throw new HarnessSkillError('harness_provider_turn_mismatch', 'Provider response turn does not match the durable run.')
    const calls = response.calls.map((call) => durableCall(record, call))
    const needs = response.needs.map((need) => ({ id: need.id, prompt: need.prompt, inputSchema: need.inputSchema }))
    record = this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      batch: response,
      calls,
      needs,
      callResults: [],
      needResults: [],
      status: needs.length > 0
        ? 'waiting_for_input'
        : calls.some((call) => call.approval === 'pending')
          ? 'waiting_for_approval'
          : 'running',
    }))
    if (record.status !== 'running') return record
    return this.executeAndContinue(record)
  }

  private async executeAndContinue(record: HarnessRunRecord): Promise<HarnessRunRecord> {
    if (!record.batch) throw new HarnessSkillError('harness_batch_missing', 'Harness run has no durable action batch to resume.')
    for (const durable of record.calls) {
      if (durable.status === 'executing') {
        throw new HarnessSkillError('harness_tool_outcome_ambiguous', `Call '${durable.id}' was interrupted after dispatch and will not be repeated.`)
      }
      if (durable.status !== 'pending') continue
      if ((durable.dependsOn ?? []).some((id) => record.callResults.find((result) => result.id === id)?.status !== 'succeeded')) {
        record = this.recordCallOutcome(record, durable.id, 'failed', 'Dependency failed.')
        continue
      }
      const entry = record.catalog.find((tool) => tool.name === durable.tool)
      if (!entry) throw new HarnessSkillError('harness_tool_unknown', `Tool '${durable.tool}' is absent from the frozen catalog.`)
      record = this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        calls: current.calls.map((call) => call.id === durable.id ? { ...call, status: 'executing' } : call),
      }))
      const outcome = await this.tools.execute(entry, durable.arguments, record.spec.mcpServers ?? [])
      if (outcome.status === 'authentication_required') {
        return this.store.update(record.runId, record.revision, (current) => ({
          ...current,
          status: 'waiting_for_authentication',
          calls: current.calls.map((call) => call.id === durable.id
            ? { ...call, status: 'authentication_required', handoff: outcome.handoff }
            : call),
        }))
      }
      record = this.recordCallOutcome(record, durable.id, outcome.status, outcome.content)
    }

    const needResults = record.needs.map((need) => {
      if (need.answer === undefined) throw new HarnessSkillError('harness_input_missing', `Answer for need '${need.id}' is required.`)
      return { id: need.id, status: 'answered' as const, value: need.answer }
    })
    const result: HarnessActionBatchResult = {
      protocol: WEB_AGENT_PROTOCOL,
      kind: 'action_batch_result',
      batchId: sha256({ runId: record.runId, turn: record.turn, nonce: record.nonce }),
      callResults: record.callResults,
      needResults,
    }
    if (record.turn >= (record.spec.maxTurns ?? 8)) throw new HarnessSkillError('harness_turn_limit', 'Harness run reached maxTurns.')
    const nextTurn = record.turn + 1
    const nextNonce = opaqueRef('nonce')
    const nextRequestRef = opaqueRef('request')
    record = this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      turn: nextTurn,
      nonce: nextNonce,
      requestRef: nextRequestRef,
      needResults,
      history: [...current.history, {
        batch: current.batch!, calls: current.calls, needs: current.needs,
        callResults: current.callResults, needResults,
      }],
    }))
    const pendingProviderRequest = providerRequest(record, result)
    record = this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      status: 'submitting_provider',
      pendingProviderRequest,
      batch: undefined,
      calls: [],
      needs: [],
      callResults: [],
      needResults: [],
    }))
    return this.submitPending(record)
  }

  private async submitPending(record: HarnessRunRecord) {
    const request = record.pendingProviderRequest
    if (!request) throw new HarnessSkillError('harness_provider_intent_missing', 'Harness provider submission intent is missing.')
    try {
      const providerTurn = request.continuation
        ? await this.provider.continue(request)
        : await this.provider.start(request)
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        status: providerStatus(providerTurn.lifecycle),
        providerTurn,
        pendingProviderRequest: undefined,
      }))
    } catch {
      // An ambiguous transport failure retains the exact request for idempotent replay.
      return record
    }
  }

  private recordCallOutcome(record: HarnessRunRecord, callId: string, status: 'succeeded' | 'failed', content: JsonValue) {
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      calls: current.calls.map((call) => call.id === callId ? { ...call, status, outcome: content } : call),
      callResults: [...current.callResults, { id: callId, status, content }],
    }))
  }

  private fail(record: HarnessRunRecord, error: unknown) {
    if (isTerminal(record.status)) return record
    const safe = error instanceof HarnessSkillError
      ? { code: error.code, message: error.message }
      : { code: 'harness_run_failed', message: error instanceof Error ? error.message : 'Harness run failed.' }
    return this.store.update(record.runId, record.revision, (current) => ({ ...current, status: 'failed', error: safe }))
  }

  private required(runId: string) {
    const record = this.store.read(runId)
    if (!record) throw new HarnessSkillError('harness_run_missing', 'Harness run does not exist.')
    return record
  }
}

function providerRequest(record: HarnessRunRecord, result?: HarnessActionBatchResult): ProviderTurnRequest {
  const base = {
    protocol: PROVIDER_TURN_PROTOCOL,
    requestRef: record.requestRef,
    runId: record.runId,
    turn: record.turn,
    nonce: record.nonce,
    provider: record.spec.provider,
    profileId: record.spec.profileId,
    stagingRoot: record.spec.stagingRoot,
    selectedSkills: record.spec.selectedSkills,
    tools: record.catalog.map(({ server: _server, serverToolName: _name, readOnly: _readOnly, approval: _approval, ...tool }) => tool),
    finalOutput: record.spec.finalOutput,
    limits: record.spec.limits,
  } satisfies ProviderTurnRequest
  if (!result) return { ...base, taskPrompt: record.spec.taskPrompt }
  const previous = record.providerTurn
  if (!previous) throw new HarnessSkillError('harness_provider_state_missing', 'Harness continuation has no provider state.')
  return {
    ...base,
    continuation: {
      providerRef: previous.providerRef,
      providerBindingRef: previous.providerBindingRef,
      conversationRef: previous.conversationRef,
      result,
      skillLoads: record.history.at(-1)?.batch.skillLoads ?? [],
    },
  }
}

function durableCall(record: HarnessRunRecord, call: HarnessActionBatch['calls'][number]): DurableCall {
  const entry = record.catalog.find((tool) => tool.name === call.tool)
  if (!entry) throw new HarnessSkillError('harness_tool_unknown', `Tool '${call.tool}' is absent from the frozen catalog.`)
  const requiresApproval = entry.approval === 'always' || !entry.readOnly
  return {
    id: call.id,
    tool: call.tool,
    arguments: call.arguments,
    argumentsDigest: sha256({ runId: record.runId, callId: call.id, tool: call.tool, arguments: call.arguments }),
    dependsOn: call.dependsOn ?? [],
    approval: requiresApproval ? 'pending' : 'not_required',
    status: 'pending',
  }
}

function publicView(record: HarnessRunRecord): AgentRunView {
  const waiting = record.status === 'waiting_for_approval'
    ? { kind: 'approval' as const, calls: record.calls.filter((call) => call.approval === 'pending').map(publicCall) }
    : record.status === 'waiting_for_authentication'
      ? {
          kind: 'authentication' as const,
          calls: record.calls.filter((call) => call.status === 'authentication_required').map(publicCall),
          handoff: record.calls.find((call) => call.status === 'authentication_required')?.handoff,
        }
      : record.status === 'waiting_for_input'
        ? { kind: 'user_input' as const, needs: record.batch?.needs ?? [] }
        : record.providerTurn?.lifecycle === 'waiting_for_user'
          ? { kind: 'provider' as const, handoff: record.providerTurn.waitingReason }
          : undefined
  return {
    protocol: HARNESS_RUN_PROTOCOL,
    runId: record.runId,
    status: record.status,
    turn: record.turn,
    ...(record.providerTurn ? { providerTurnRef: record.providerTurn.turnRef } : {}),
    ...(waiting ? { waiting } : {}),
    ...(record.final ? { final: { output: record.final.output, artifacts: record.final.artifacts } } : {}),
    ...(record.error ? { error: record.error } : {}),
  }
}

function publicCall(call: DurableCall) {
  return { id: call.id, tool: call.tool, argumentsDigest: call.argumentsDigest }
}

function validateSpec(input: AgentRunSpec): AgentRunSpec {
  if (!input || typeof input !== 'object' || typeof input.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider)) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run provider is invalid.')
  }
  if (typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.profileId)) throw new HarnessSkillError('harness_spec_invalid', 'Agent run profileId is invalid.')
  if (typeof input.taskPrompt !== 'string' || input.taskPrompt.trim() === '' || Buffer.byteLength(input.taskPrompt, 'utf8') > 64 * 1024) throw new HarnessSkillError('harness_spec_invalid', 'Agent run taskPrompt is invalid.')
  if (typeof input.stagingRoot !== 'string' || input.stagingRoot.trim() === '' || input.stagingRoot.includes('\0')) throw new HarnessSkillError('harness_spec_invalid', 'Agent run stagingRoot is invalid.')
  if (!Number.isSafeInteger(input.maxTurns ?? 8) || (input.maxTurns ?? 8) < 1 || (input.maxTurns ?? 8) > 32) throw new HarnessSkillError('harness_spec_invalid', 'Agent run maxTurns must be 1-32.')
  return { ...input, mcpServers: input.mcpServers ?? [] }
}

function providerStatus(lifecycle: string) {
  if (lifecycle === 'waiting_for_user') return 'running' as const
  if (lifecycle === 'failed' || lifecycle === 'cancelled') return lifecycle
  return 'running' as const
}

function isTerminal(status: string) { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function isRecoverableInterventionError(error: unknown) {
  return error instanceof HarnessSkillError && [
    'harness_approval_invalid',
    'harness_input_missing',
    'harness_auth_resume_invalid',
    'harness_run_not_resumable',
  ].includes(error.code)
}
function opaqueRef(kind: 'run' | 'nonce' | 'request') { return `${kind}:${randomBytes(16).toString('hex')}` }
function sha256(value: unknown) { return createHash('sha256').update(canonicalJson(value as JsonValue)).digest('hex') }
