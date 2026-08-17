import { createHash, randomBytes } from 'node:crypto'

import {
  HARNESS_RUN_PROTOCOL,
  PROVIDER_TURN_PROTOCOL,
  WEB_AGENT_PROTOCOL,
  HarnessSkillError,
  ProviderTurnDispatchError,
  type AgentRunIntervention,
  type AgentRunSpec,
  type AgentRunView,
  type HarnessActionBatch,
  type HarnessActionBatchResult,
  type HarnessToolCatalogEntry,
  type HarnessToolRegistry,
  type JsonValue,
  type ProviderTurnClient,
  type ProviderTurnState,
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
    const admitted = this.store.admit({
      protocol: HARNESS_RUN_PROTOCOL,
      runId,
      revision: 0,
      status: 'discovering_tools',
      phase: 'discovering_tools',
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
    }, sha256(spec))
    return publicView(admitted.record)
  }

  async read(runId: string): Promise<AgentRunView | null> {
    let record = this.store.read(runId)
    if (!record) return null
    try {
      if (record.phase === 'discovering_tools') record = await this.discoverTools(record)
      else if (record.phase === 'submitting_provider') record = await this.submitPending(record)
      else if (record.phase === 'awaiting_provider') record = await this.readProvider(record)
      else if (record.phase === 'executing_batch') record = await this.executeAndContinue(record)
      return publicView(record)
    } catch (error) {
      if (isRecoverableInterventionError(error)) throw error
      if (isConflict(error)) return publicView(this.required(runId))
      return publicView(this.fail(record, error))
    }
  }

  async resume(runId: string, intervention: AgentRunIntervention): Promise<AgentRunView> {
    let record = this.required(runId)
    try {
      if (record.providerTurn?.lifecycle === 'waiting_for_user') {
        if (intervention.providerReady !== true) throw new HarnessSkillError('harness_provider_resume_invalid', 'Provider intervention must be explicitly confirmed.')
        const providerTurn = await this.provider.resume({
          runId,
          requestRef: record.requestRef,
          turn: record.turn,
          nonce: record.nonce,
          stagingRoot: record.spec.stagingRoot,
          turnRef: record.providerTurn.turnRef,
          expectedDeliverySha256: record.providerTurn.deliverySha256,
        })
        assertProviderTurnIdentity(record, providerTurn)
        record = this.store.update(runId, record.revision, (current) => ({ ...current, providerTurn, status: 'running', phase: 'awaiting_provider' }))
        return publicView(record)
      } else if (record.status === 'waiting_for_approval') {
        const approvals = new Map((intervention.approvals ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.approval !== 'pending') return call
          if (approvals.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_approval_invalid', `Approval for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, approval: 'approved' as const }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', phase: 'executing_batch', calls }))
      } else if (record.status === 'waiting_for_input') {
        const answers = intervention.answers ?? {}
        const needs = record.needs.map((need) => {
          if (!Object.hasOwn(answers, need.id)) throw new HarnessSkillError('harness_input_missing', `Answer for need '${need.id}' is required.`)
          return { ...need, answer: answers[need.id]! }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', phase: 'executing_batch', needs }))
      } else if (record.status === 'waiting_for_authentication') {
        const completed = new Map((intervention.authenticationCompleted ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.status !== 'authentication_required') return call
          if (completed.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_auth_resume_invalid', `Authentication resume for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, status: 'pending' as const, handoff: undefined }
        })
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'running', phase: 'executing_batch', calls }))
      } else {
        throw new HarnessSkillError('harness_run_not_resumable', 'Harness run is not waiting for a supported intervention.')
      }
      return publicView(record)
    } catch (error) {
      if (isRecoverableInterventionError(error)) throw error
      if (isConflict(error)) throw error
      return publicView(this.fail(record, error))
    }
  }

  async cancel(runId: string): Promise<AgentRunView> {
    let record = this.required(runId)
    if (isTerminal(record.status)) return publicView(record)
    try {
      if (record.calls.some((call) => call.status === 'executing')) {
        record = this.store.update(runId, record.revision, (current) => ({
          ...current,
          status: 'reconciliation_required',
          phase: 'reconciliation_required',
          error: { code: 'harness_cancel_outcome_ambiguous', message: 'A dispatched tool call requires reconciliation and was not reported cancelled.' },
        }))
      } else if (record.phase === 'submitting_provider' && record.providerTurn?.requestRef !== record.requestRef) {
        const cancellation = await this.provider.cancel({ requestRef: record.requestRef })
        assertProviderCancellationIdentity(record.requestRef, cancellation)
        record = this.store.update(runId, record.revision, (current) => cancellation.kind === 'turn'
          ? { ...current, providerTurn: cancellation.turn, status: 'cancelled', phase: 'terminal', pendingProviderRequest: undefined }
          : { ...current, status: 'cancelled', phase: 'terminal', pendingProviderRequest: undefined })
      } else if (record.providerTurn && ['queued', 'running', 'waiting_for_user'].includes(record.providerTurn.lifecycle)) {
        const cancellation = await this.provider.cancel({ requestRef: record.requestRef, turnRef: record.providerTurn.turnRef })
        assertProviderCancellationIdentity(record.requestRef, cancellation)
        record = this.store.update(runId, record.revision, (current) => ({
          ...current,
          ...(cancellation.kind === 'turn' ? { providerTurn: cancellation.turn } : {}),
          status: 'cancelled',
          phase: 'terminal',
          pendingProviderRequest: undefined,
        }))
      } else {
        record = this.store.update(runId, record.revision, (current) => ({ ...current, status: 'cancelled', phase: 'terminal' }))
      }
      return publicView(record)
    } catch (error) {
      if (isConflict(error)) throw error
      return publicView(this.fail(record, error))
    }
  }

  close() { this.store.close() }

  private async discoverTools(record: HarnessRunRecord) {
    const catalog = await this.tools.catalog(record.spec.mcpServers ?? [])
    const pendingProviderRequest = providerRequest({ ...record, catalog })
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      catalog,
      status: 'submitting_provider',
      phase: 'submitting_provider',
      pendingProviderRequest,
    }))
  }

  private async readProvider(record: HarnessRunRecord) {
    const existing = record.providerTurn
    if (!existing) throw new HarnessSkillError('harness_provider_state_missing', 'Harness provider turn is missing.')
    const providerTurn = await this.provider.read({
      runId: record.runId,
      requestRef: record.requestRef,
      turn: record.turn,
      nonce: record.nonce,
      stagingRoot: record.spec.stagingRoot,
      turnRef: existing.turnRef,
      expectedDeliverySha256: existing.deliverySha256,
    })
    assertProviderTurnIdentity(record, providerTurn)
    if (providerTurn.lifecycle === 'succeeded') return this.acceptProviderResponse(record, providerTurn)
    const terminal = providerTurn.lifecycle === 'failed' || providerTurn.lifecycle === 'cancelled'
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      providerTurn,
      status: providerStatus(providerTurn.lifecycle),
      phase: terminal ? 'terminal' : 'awaiting_provider',
      ...(providerTurn.lifecycle === 'failed'
        ? { error: providerTurn.error ?? { code: 'harness_provider_failed', message: 'Provider turn failed.' } }
        : {}),
    }))
  }

  private acceptProviderResponse(record: HarnessRunRecord, providerTurn: ProviderTurnState) {
    const response = providerTurn.modelResponse
    if (!response) throw new HarnessSkillError('harness_provider_response_missing', 'Provider turn succeeded without a validated Harness response.')
    assertModelResponseIdentity(record, response)
    if (response.kind === 'final') {
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        providerTurn,
        status: 'succeeded',
        phase: 'terminal',
        final: response,
      }))
    }
    const batchId = sha256({ runId: record.runId, turn: record.turn, nonce: record.nonce, batch: response })
    const calls = response.calls.map((call) => durableCall(record, batchId, call))
    const needs = response.needs.map((need) => ({ id: need.id, prompt: need.prompt, inputSchema: need.inputSchema }))
    const status = needs.length > 0
      ? 'waiting_for_input'
      : calls.some((call) => call.approval === 'pending')
        ? 'waiting_for_approval'
        : 'running'
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      providerTurn,
      batch: response,
      batchId,
      calls,
      needs,
      callResults: [],
      needResults: [],
      status,
      phase: status === 'running' ? 'executing_batch' : 'waiting_intervention',
    }))
  }

  private async executeAndContinue(record: HarnessRunRecord): Promise<HarnessRunRecord> {
    if (!record.batch) throw new HarnessSkillError('harness_batch_missing', 'Harness run has no durable action batch to resume.')
    const batch = record.batch
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
          phase: 'waiting_intervention',
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
    const next = {
      ...record,
      turn: record.turn + 1,
      nonce: opaqueRef('nonce'),
      requestRef: opaqueRef('request'),
      needResults,
      history: [...record.history, {
        batchId: record.batchId!, batch, calls: record.calls, needs: record.needs,
        callResults: record.callResults, needResults,
      }],
    }
    const pendingProviderRequest = providerRequest(next, result)
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      turn: next.turn,
      nonce: next.nonce,
      requestRef: next.requestRef,
      history: next.history,
      status: 'submitting_provider',
      phase: 'submitting_provider',
      pendingProviderRequest,
      batch: undefined,
      batchId: undefined,
      calls: [],
      needs: [],
      callResults: [],
      needResults: [],
    }))
  }

  private async submitPending(record: HarnessRunRecord) {
    const request = record.pendingProviderRequest
    if (!request) throw new HarnessSkillError('harness_provider_intent_missing', 'Harness provider submission intent is missing.')
    try {
      const providerTurn = request.continuation
        ? await this.provider.continue(request)
        : await this.provider.start(request)
      assertProviderTurnIdentity(record, providerTurn)
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        status: providerStatus(providerTurn.lifecycle),
        phase: providerTurn.lifecycle === 'failed' || providerTurn.lifecycle === 'cancelled' ? 'terminal' : 'awaiting_provider',
        providerTurn,
        pendingProviderRequest: undefined,
        ...(providerTurn.lifecycle === 'failed'
          ? { error: providerTurn.error ?? { code: 'harness_provider_failed', message: 'Provider turn failed.' } }
          : {}),
      }))
    } catch (error) {
      if (error instanceof ProviderTurnDispatchError && error.dispatch === 'ambiguous') return record
      return this.fail(record, error)
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
    const safe = error instanceof HarnessSkillError || error instanceof ProviderTurnDispatchError
      ? { code: error.code, message: error.message }
      : { code: 'harness_run_failed', message: 'Harness run failed.' }
    try {
      return this.store.update(record.runId, record.revision, (current) => ({ ...current, status: 'failed', phase: 'terminal', error: safe }))
    } catch (failure) {
      if (isConflict(failure)) return this.required(record.runId)
      throw failure
    }
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

function durableCall(record: HarnessRunRecord, batchId: string, call: HarnessActionBatch['calls'][number]): DurableCall {
  const entry = record.catalog.find((tool) => tool.name === call.tool)
  if (!entry) throw new HarnessSkillError('harness_tool_unknown', `Tool '${call.tool}' is absent from the frozen catalog.`)
  const requiresApproval = entry.approval === 'always' || !entry.readOnly
  return {
    id: call.id,
    tool: call.tool,
    arguments: call.arguments,
    argumentsDigest: sha256({
      runId: record.runId,
      turn: record.turn,
      nonce: record.nonce,
      batchId,
      callId: call.id,
      tool: call.tool,
      arguments: call.arguments,
    }),
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
    admissionRef: record.spec.admissionRef,
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
  return { id: call.id, tool: call.tool, arguments: call.arguments, argumentsDigest: call.argumentsDigest }
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

function assertProviderTurnIdentity(record: HarnessRunRecord, providerTurn: ProviderTurnState) {
  if (providerTurn.protocol !== PROVIDER_TURN_PROTOCOL || providerTurn.requestRef !== record.requestRef) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider turn does not match the durable request identity.')
  }
  const prior = record.providerTurn
  if (prior && (
    (record.phase !== 'submitting_provider' && providerTurn.turnRef !== prior.turnRef) ||
    providerTurn.providerRef !== prior.providerRef ||
    providerTurn.providerBindingRef !== prior.providerBindingRef ||
    providerTurn.conversationRef !== prior.conversationRef
  )) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider turn changed its frozen provider identity.')
  }
}

function assertProviderCancellationIdentity(requestRef: string, cancellation: import('./contracts.js').ProviderTurnCancellation) {
  if (cancellation.protocol !== PROVIDER_TURN_PROTOCOL || cancellation.requestRef !== requestRef ||
    (cancellation.kind === 'turn' && cancellation.turn.requestRef !== requestRef)) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider cancellation does not match the durable request identity.')
  }
}

function assertModelResponseIdentity(record: HarnessRunRecord, response: HarnessActionBatch | import('./contracts.js').HarnessFinalResponse) {
  if (response.runId !== record.runId || response.turn !== record.turn || response.nonce !== record.nonce) {
    throw new HarnessSkillError('harness_provider_response_identity_mismatch', 'Provider response does not match the durable run turn and nonce.')
  }
}

function isTerminal(status: string) { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function isConflict(error: unknown) { return error instanceof HarnessSkillError && error.code === 'harness_run_conflict' }
function isRecoverableInterventionError(error: unknown) {
  return error instanceof HarnessSkillError && [
    'harness_approval_invalid',
    'harness_input_missing',
    'harness_auth_resume_invalid',
    'harness_run_not_resumable',
    'harness_provider_resume_invalid',
  ].includes(error.code)
}
function opaqueRef(kind: 'run' | 'nonce' | 'request') {
  const separator = kind === 'run' ? '_' : ':'
  return `${kind}${separator}${randomBytes(16).toString('hex')}`
}
function sha256(value: unknown) { return createHash('sha256').update(canonicalJson(value as JsonValue)).digest('hex') }
