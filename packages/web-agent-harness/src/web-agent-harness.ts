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
import { validateJsonSchemaValue } from './internal/json-schema.js'
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
      else if (record.phase === 'resuming_provider') record = await this.resumeProvider(record)
      else if (record.phase === 'cancelling_provider') record = await this.cancelProvider(record)
      else if (record.phase === 'executing_batch') record = await this.executeAndContinue(record)
      return publicView(record)
    } catch (error) {
      if (error instanceof ProviderTurnDispatchError && error.dispatch === 'ambiguous') return publicView(record)
      if (isRecoverableInterventionError(error)) throw error
      if (isConflict(error)) return publicView(this.required(runId))
      return publicView(this.fail(record, error))
    }
  }

  async readAdmission(admissionRef: string): Promise<AgentRunView | null> {
    const record = this.store.readByAdmission(admissionRef)
    return record ? publicView(record) : null
  }

  async resume(runId: string, intervention: AgentRunIntervention): Promise<AgentRunView> {
    let record = this.required(runId)
    try {
      if (record.providerTurn?.lifecycle === 'waiting_for_user') {
        if (intervention.providerReady !== true) throw new HarnessSkillError('harness_provider_resume_invalid', 'Provider intervention must be explicitly confirmed.')
        record = this.store.update(runId, record.revision, (current) => ({
          ...current,
          phase: 'resuming_provider',
          pendingProviderOperation: { kind: 'resume', requestRef: current.requestRef, turnRef: current.providerTurn!.turnRef },
        }))
        return publicView(await this.resumeProvider(record))
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
        if (!isRecord(answers)) throw new HarnessSkillError('harness_input_invalid', 'Harness answers must be a JSON object.')
        const needIds = new Set(record.needs.map((need) => need.id))
        if (Object.keys(answers).some((id) => !needIds.has(id))) {
          throw new HarnessSkillError('harness_input_invalid', 'Harness answers contain an undeclared need ID.')
        }
        const needs = record.needs.map((need) => {
          if (!Object.hasOwn(answers, need.id)) throw new HarnessSkillError('harness_input_missing', `Answer for need '${need.id}' is required.`)
          validateJsonSchemaValue(need.inputSchema, answers[need.id], `Answer for need '${need.id}'`)
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
        record = this.store.update(runId, record.revision, (current) => ({
          ...current,
          phase: 'cancelling_provider',
          pendingProviderOperation: { kind: 'cancel', requestRef: current.requestRef },
        }))
        record = await this.cancelProvider(record)
      } else if (record.providerTurn && ['queued', 'running', 'waiting_for_user'].includes(record.providerTurn.lifecycle)) {
        record = this.store.update(runId, record.revision, (current) => ({
          ...current,
          phase: 'cancelling_provider',
          pendingProviderOperation: { kind: 'cancel', requestRef: current.requestRef, turnRef: current.providerTurn!.turnRef },
        }))
        record = await this.cancelProvider(record)
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

  private async resumeProvider(record: HarnessRunRecord) {
    const turn = record.providerTurn
    if (!turn || record.pendingProviderOperation?.kind !== 'resume') throw new HarnessSkillError('harness_provider_intent_missing', 'Harness provider resume intent is missing.')
    assertProviderTurnIdentity(record, turn)
    try {
      const providerTurn = await this.provider.resume({
        runId: record.runId, requestRef: record.requestRef, turn: record.turn, nonce: record.nonce,
        provider: record.spec.provider, profileId: record.spec.profileId, stagingRoot: record.spec.stagingRoot,
        turnRef: turn.turnRef, providerRef: turn.providerRef, providerBindingRef: turn.providerBindingRef,
        conversationRef: turn.conversationRef, expectedDeliverySha256: turn.deliverySha256,
      })
      assertProviderTurnIdentity(record, providerTurn)
      const terminal = providerTurn.lifecycle === 'failed' || providerTurn.lifecycle === 'cancelled'
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        providerTurn,
        pendingProviderOperation: undefined,
        status: providerStatus(providerTurn.lifecycle),
        phase: terminal ? 'terminal' : 'awaiting_provider',
        ...(providerTurn.lifecycle === 'failed'
          ? { error: providerTurn.error ?? { code: 'harness_provider_failed', message: 'Provider turn failed.' } }
          : {}),
      }))
    } catch (error) {
      if (error instanceof ProviderTurnDispatchError && error.dispatch === 'ambiguous') return record
      return this.fail(record, error)
    }
  }

  private async cancelProvider(record: HarnessRunRecord) {
    const operation = record.pendingProviderOperation
    if (operation?.kind !== 'cancel') throw new HarnessSkillError('harness_provider_intent_missing', 'Harness provider cancel intent is missing.')
    const prior = operation.turnRef ? record.providerTurn : undefined
    if (prior) assertProviderTurnIdentity(record, prior)
    try {
      const cancellation = await this.provider.cancel({
        requestRef: record.requestRef, runId: record.runId, turn: record.turn, nonce: record.nonce,
        provider: record.spec.provider, profileId: record.spec.profileId,
        ...(prior ? {
          turnRef: prior.turnRef, providerRef: prior.providerRef,
          providerBindingRef: prior.providerBindingRef, conversationRef: prior.conversationRef,
        } : {}),
      })
      assertProviderCancellationIdentity(record.requestRef, cancellation)
      if (cancellation.kind === 'cancelled_before_start') {
        return this.store.update(record.runId, record.revision, (current) => ({
          ...current, status: 'cancelled', phase: 'terminal', pendingProviderRequest: undefined, pendingProviderOperation: undefined,
        }))
      }
      assertProviderTurnIdentity(record, cancellation.turn)
      const terminal = cancellation.turn.lifecycle === 'cancelled' || cancellation.turn.lifecycle === 'failed'
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        providerTurn: cancellation.turn,
        pendingProviderRequest: undefined,
        pendingProviderOperation: undefined,
        status: cancellation.turn.lifecycle === 'cancelled' ? 'cancelled' : providerStatus(cancellation.turn.lifecycle),
        phase: terminal ? 'terminal' : 'awaiting_provider',
        ...(cancellation.turn.lifecycle === 'failed'
          ? { error: cancellation.turn.error ?? { code: 'harness_provider_failed', message: 'Provider turn failed.' } }
          : {}),
      }))
    } catch (error) {
      if (error instanceof ProviderTurnDispatchError && error.dispatch === 'ambiguous') return record
      return this.fail(record, error)
    }
  }

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
    assertProviderTurnIdentity(record, existing)
    const providerTurn = await this.provider.read({
      runId: record.runId,
      requestRef: record.requestRef,
      turn: record.turn,
      nonce: record.nonce,
      provider: record.spec.provider,
      profileId: record.spec.profileId,
      stagingRoot: record.spec.stagingRoot,
      turnRef: existing.turnRef,
      providerRef: existing.providerRef,
      providerBindingRef: existing.providerBindingRef,
      conversationRef: existing.conversationRef,
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
    if (!record.batch || !record.batchId) throw new HarnessSkillError('harness_batch_missing', 'Harness run has no durable action batch to resume.')
    const batch = record.batch
    const batchId = record.batchId
    if (record.needs.some((need) => need.answer === undefined)) {
      return this.waitFor(record, 'waiting_for_input')
    }

    for (const durable of record.calls.filter((call) => call.status === 'executing')) {
      record = this.recordCallOutcome(record, durable.id, 'failed', {
        code: 'harness_tool_outcome_ambiguous',
        dispatched: true,
      })
    }

    let progressed: boolean
    do {
      progressed = false
      for (const durable of record.calls) {
        if (durable.status !== 'pending' || durable.approval === 'pending') continue
        if (durable.approval !== 'approved' && durable.approval !== 'not_required') {
          throw new HarnessSkillError('harness_approval_state_invalid', `Call '${durable.id}' is not authorized for execution.`)
        }
        const dependencies = durable.dependsOn.map((id) => record.callResults.find((result) => result.id === id))
        if (dependencies.some((result) => result?.status === 'failed')) {
          record = this.recordCallOutcome(record, durable.id, 'failed', { code: 'harness_tool_dependency_failed' })
          progressed = true
          continue
        }
        if (dependencies.some((result) => result === undefined)) continue
        const entry = record.catalog.find((tool) => tool.name === durable.tool)
        if (!entry) {
          record = this.recordCallOutcome(record, durable.id, 'failed', { code: 'harness_tool_not_in_frozen_catalog' })
          progressed = true
          continue
        }
        record = this.store.update(record.runId, record.revision, (current) => ({
          ...current,
          calls: current.calls.map((call) => call.id === durable.id ? { ...call, status: 'executing' } : call),
        }))
        try {
          const outcome = await this.tools.execute(entry, durable.arguments, record.spec.mcpServers ?? [])
          if (outcome.status === 'authentication_required') {
            record = this.store.update(record.runId, record.revision, (current) => ({
              ...current,
              calls: current.calls.map((call) => call.id === durable.id
                ? { ...call, status: 'authentication_required', handoff: outcome.handoff }
                : call),
            }))
          } else {
            record = this.recordCallOutcome(record, durable.id, outcome.status, outcome.content)
          }
        } catch {
          record = this.recordCallOutcome(record, durable.id, 'failed', { code: 'harness_tool_execution_failed' })
        }
        progressed = true
      }
    } while (progressed)

    if (record.calls.some((call) => call.status === 'pending' && call.approval === 'pending')) {
      return this.waitFor(record, 'waiting_for_approval')
    }
    if (record.calls.some((call) => call.status === 'authentication_required')) {
      return this.waitFor(record, 'waiting_for_authentication')
    }
    for (const durable of record.calls.filter((call) => call.status === 'pending')) {
      record = this.recordCallOutcome(record, durable.id, 'failed', { code: 'harness_tool_dependency_unavailable' })
    }

    const needResults = record.needs.map((need) => {
      if (need.answer === undefined) throw new HarnessSkillError('harness_input_missing', `Answer for need '${need.id}' is required.`)
      return { id: need.id, status: 'answered' as const, value: need.answer }
    })
    const result = boundedActionBatchResult(batchId, record.callResults, needResults)
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

  private waitFor(record: HarnessRunRecord, status: 'waiting_for_input' | 'waiting_for_approval' | 'waiting_for_authentication') {
    return this.store.update(record.runId, record.revision, (current) => ({
      ...current,
      status,
      phase: 'waiting_intervention',
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
      callResults: [...current.callResults.filter((result) => result.id !== callId), { id: callId, status, content }],
    }))
  }

  private fail(record: HarnessRunRecord, error: unknown) {
    if (isTerminal(record.status)) return record
    const safe = error instanceof HarnessSkillError || error instanceof ProviderTurnDispatchError
      ? { code: error.code, message: error.message }
      : { code: 'harness_run_failed', message: 'Harness run failed.' }
    try {
      return this.store.update(record.runId, record.revision, (current) => ({
        ...current,
        status: 'failed',
        phase: 'terminal',
        pendingProviderRequest: undefined,
        pendingProviderOperation: undefined,
        error: safe,
      }))
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
  if (!isRecord(input)) throw new HarnessSkillError('harness_spec_invalid', 'Agent run spec must be a JSON object.')
  assertExactKeys(input, [
    'admissionRef', 'provider', 'profileId', 'taskPrompt', 'stagingRoot', 'selectedSkills',
    'finalOutput', 'limits', 'maxTurns', 'mcpServers',
  ], 'Agent run spec')
  if (!/^admission:[a-f0-9]{32,64}$/u.test(String(input.admissionRef))) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run admissionRef is invalid.')
  }
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider)) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run provider is invalid.')
  }
  if (typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.profileId)) throw new HarnessSkillError('harness_spec_invalid', 'Agent run profileId is invalid.')
  if (typeof input.taskPrompt !== 'string' || input.taskPrompt.trim() === '' || Buffer.byteLength(input.taskPrompt, 'utf8') > 64 * 1024) throw new HarnessSkillError('harness_spec_invalid', 'Agent run taskPrompt is invalid.')
  if (typeof input.stagingRoot !== 'string' || input.stagingRoot.trim() === '' || input.stagingRoot.includes('\0')) throw new HarnessSkillError('harness_spec_invalid', 'Agent run stagingRoot is invalid.')
  if (!Number.isSafeInteger(input.maxTurns ?? 8) || (input.maxTurns ?? 8) < 1 || (input.maxTurns ?? 8) > 32) throw new HarnessSkillError('harness_spec_invalid', 'Agent run maxTurns must be 1-32.')
  const selectedSkills = sanitizeSelectedSkills(input.selectedSkills)
  const finalOutput = sanitizeFinalOutput(input.finalOutput)
  const limits = sanitizeLimits(input.limits)
  const mcpServers = sanitizeMcpServers(input.mcpServers)
  return {
    admissionRef: input.admissionRef,
    provider: input.provider,
    profileId: input.profileId,
    taskPrompt: input.taskPrompt,
    stagingRoot: input.stagingRoot,
    ...(selectedSkills ? { selectedSkills } : {}),
    ...(finalOutput ? { finalOutput } : {}),
    ...(limits ? { limits } : {}),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    mcpServers,
  }
}

function sanitizeSelectedSkills(value: unknown): AgentRunSpec['selectedSkills'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 256) throw new HarnessSkillError('harness_spec_invalid', 'selectedSkills is invalid.')
  return value.map((item) => {
    if (!isRecord(item)) throw new HarnessSkillError('harness_spec_invalid', 'selectedSkills is invalid.')
    assertExactKeys(item, ['name', 'selectedBy', 'expectedSha256'], 'Skill selection')
    if (typeof item.name !== 'string' || item.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name) ||
      !['explicit_user', 'caller_agent', 'web_model'].includes(String(item.selectedBy)) ||
      (item.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(String(item.expectedSha256)))) {
      throw new HarnessSkillError('harness_spec_invalid', 'selectedSkills is invalid.')
    }
    return {
      name: item.name,
      selectedBy: item.selectedBy as 'explicit_user' | 'caller_agent' | 'web_model',
      ...(item.expectedSha256 === undefined ? {} : { expectedSha256: String(item.expectedSha256) }),
    }
  })
}

function sanitizeFinalOutput(value: unknown): AgentRunSpec['finalOutput'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || (value.kind !== 'markdown' && value.kind !== 'json_schema')) throw new HarnessSkillError('harness_spec_invalid', 'finalOutput is invalid.')
  assertExactKeys(value, value.kind === 'markdown' ? ['kind'] : ['kind', 'schema'], 'finalOutput')
  if (value.kind === 'markdown') return { kind: 'markdown' }
  if (!isJsonValue(value.schema)) throw new HarnessSkillError('harness_spec_invalid', 'finalOutput schema is invalid.')
  return { kind: 'json_schema', schema: value.schema }
}

function sanitizeLimits(value: unknown): AgentRunSpec['limits'] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new HarnessSkillError('harness_spec_invalid', 'limits is invalid.')
  const keys = [
    'maxSkills', 'maxRegistryBytes', 'maxFrontmatterBytes', 'maxSkillFileBytes',
    'maxSkillAttachmentsPerTurn', 'maxSkillAttachmentBytesPerTurn',
  ] as const
  assertExactKeys(value, keys, 'limits')
  const result: Record<string, number> = {}
  for (const key of keys) {
    const item = value[key]
    if (item === undefined) continue
    if (!Number.isSafeInteger(item) || Number(item) <= 0) throw new HarnessSkillError('harness_spec_invalid', `limits.${key} is invalid.`)
    result[key] = Number(item)
  }
  return result
}

function sanitizeMcpServers(value: unknown): NonNullable<AgentRunSpec['mcpServers']> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new HarnessSkillError('harness_spec_invalid', 'mcpServers is invalid.')
  const names = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) throw new HarnessSkillError('harness_spec_invalid', 'mcpServers is invalid.')
    assertExactKeys(item, ['name', 'command', 'args', 'envKeys', 'timeoutMs', 'enabledTools'], 'MCP server')
    if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item.name) ||
      typeof item.command !== 'string' || item.command.trim() === '' || item.command.length > 1024 || item.command.includes('\0')) {
      throw new HarnessSkillError('harness_spec_invalid', 'mcpServers is invalid.')
    }
    if (names.has(item.name)) throw new HarnessSkillError('harness_spec_invalid', 'MCP server names must be unique.')
    names.add(item.name)
    const args = sanitizeStringArray(item.args, 64, 4096, 'MCP args')
    const envKeys = sanitizeStringArray(item.envKeys, 64, 128, 'MCP envKeys', /^[A-Za-z_][A-Za-z0-9_]*$/u)
    const enabledTools = sanitizeStringArray(item.enabledTools, 256, 128, 'MCP enabledTools')
    if (item.timeoutMs !== undefined && (!Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1_000 || Number(item.timeoutMs) > 120_000)) {
      throw new HarnessSkillError('harness_spec_invalid', 'MCP timeoutMs is invalid.')
    }
    return {
      name: item.name,
      command: item.command,
      ...(args ? { args } : {}),
      ...(envKeys ? { envKeys } : {}),
      ...(item.timeoutMs === undefined ? {} : { timeoutMs: Number(item.timeoutMs) }),
      ...(enabledTools ? { enabledTools } : {}),
    }
  })
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number, label: string, pattern?: RegExp) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > maxLength || item.includes('\0') || (pattern && !pattern.test(item)))) {
    throw new HarnessSkillError('harness_spec_invalid', `${label} is invalid.`)
  }
  if (new Set(value).size !== value.length) throw new HarnessSkillError('harness_spec_invalid', `${label} must not contain duplicates.`)
  return value.map(String)
}

function providerStatus(lifecycle: string) {
  if (lifecycle === 'waiting_for_user') return 'running' as const
  if (lifecycle === 'failed' || lifecycle === 'cancelled') return lifecycle
  return 'running' as const
}

const MAX_PROVIDER_RESULT_BYTES = 768 * 1024

function boundedActionBatchResult(
  batchId: string,
  inputCalls: HarnessActionBatchResult['callResults'],
  inputNeeds: HarnessActionBatchResult['needResults'],
): HarnessActionBatchResult {
  const callResults = inputCalls.map((result) => ({ ...result }))
  const needResults = inputNeeds.map((result) => ({ ...result }))
  const result: HarnessActionBatchResult = {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'action_batch_result',
    batchId,
    callResults,
    needResults,
  }
  if (jsonBytes(result) <= MAX_PROVIDER_RESULT_BYTES) return result
  const projections = [
    ...callResults.map((item) => ({
      bytes: jsonBytes(item.content),
      apply: () => { item.content = digestProjection(item.content) },
    })),
    ...needResults.map((item) => ({
      bytes: jsonBytes(item.value),
      apply: () => { item.value = digestProjection(item.value) },
    })),
  ].toSorted((left, right) => right.bytes - left.bytes)
  for (const projection of projections) {
    projection.apply()
    if (jsonBytes(result) <= MAX_PROVIDER_RESULT_BYTES) return result
  }
  throw new HarnessSkillError('harness_provider_result_too_large', 'Harness action result exceeds the continuation byte budget.')
}

function digestProjection(value: JsonValue): JsonValue {
  return { truncated: true, byteLength: jsonBytes(value), sha256: sha256(value) }
}

function jsonBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HarnessSkillError('harness_spec_invalid', `${label} contains an unknown field.`)
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function assertProviderTurnIdentity(record: HarnessRunRecord, providerTurn: ProviderTurnState) {
  if (providerTurn.protocol !== PROVIDER_TURN_PROTOCOL || providerTurn.requestRef !== record.requestRef ||
    providerTurn.runId !== record.runId || providerTurn.turn !== record.turn || providerTurn.nonce !== record.nonce ||
    providerTurn.provider !== record.spec.provider || providerTurn.profileId !== record.spec.profileId) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider turn does not match the durable request identity.')
  }
  const prior = record.providerTurn
  if (prior && (
    (prior.requestRef === record.requestRef && providerTurn.turnRef !== prior.turnRef) ||
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
    'harness_input_invalid',
    'harness_json_schema_validation_failed',
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
