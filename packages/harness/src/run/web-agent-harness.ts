import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

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
  type HarnessFinalResponse,
  type HarnessToolCatalogEntry,
  type HarnessToolRegistry,
  type JsonValue,
  type ProviderTurnClient,
  type ProviderTurnState,
  type ProviderTurnRequest,
  type WebAgentHarness,
} from '../contracts.js'
import { canonicalJson } from '../internal/filesystem.js'
import { validateJsonSchemaValue } from '../internal/json-schema.js'
import {
  malformedBenchmarkEvidenceActionBatch,
  syntheticReissueReasonCode,
} from '../internal/model-response.js'
type HarnessCall = {
  id: string
  tool: string
  arguments: JsonValue
  argumentsDigest: string
  dependsOn: readonly string[]
  approval: 'not_required' | 'pending' | 'approved'
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'authentication_required'
  outcome?: JsonValue | undefined
  handoff?: string | undefined
}

type HarnessNeed = {
  id: string
  prompt: string
  inputSchema: JsonValue
  answer?: JsonValue | undefined
}

type HarnessRunRecord = {
  protocol: typeof HARNESS_RUN_PROTOCOL
  runId: string
  status: import('../contracts.js').AgentRunStatus
  phase: import('../contracts.js').HarnessRunPhase
  spec: AgentRunSpec
  turn: number
  nonce: string
  requestRef: string
  catalog: readonly HarnessToolCatalogEntry[]
  pendingProviderRequest?: ProviderTurnRequest | undefined
  pendingProviderOperation?: { kind: 'cancel'; requestRef: string; turnRef?: string | undefined } | undefined
  providerTurn?: ProviderTurnState | undefined
  batch?: HarnessActionBatch | undefined
  batchId?: string | undefined
  calls: readonly HarnessCall[]
  needs: readonly HarnessNeed[]
  callResults: readonly import('../contracts.js').HarnessToolCallResult[]
  needResults: readonly import('../contracts.js').HarnessNeedResult[]
  history: readonly {
    batchId: string
    batch: HarnessActionBatch
    calls: readonly HarnessCall[]
    needs: readonly HarnessNeed[]
    callResults: readonly import('../contracts.js').HarnessToolCallResult[]
    needResults: readonly import('../contracts.js').HarnessNeedResult[]
  }[]
  final?: import('../contracts.js').HarnessFinalResponse | undefined
  error?: { code: string; message: string } | undefined
}

export function openWebAgentHarness(input: {
  providerClient: ProviderTurnClient
  toolRegistry: HarnessToolRegistry
  onCorrectiveResponse?: ((event: { turn: number; reasonCode: string }) => void) | undefined
  finalEvidenceGate?: ((event: { turn: number }) => boolean) | undefined
}): WebAgentHarness {
  return new InMemoryWebAgentHarness(
    input.providerClient,
    input.toolRegistry,
    input.onCorrectiveResponse,
    input.finalEvidenceGate,
  )
}

class InMemoryWebAgentHarness implements WebAgentHarness {
  private readonly runs = new Map<string, HarnessRunRecord>()

  constructor(
    private readonly provider: ProviderTurnClient,
    private readonly tools: HarnessToolRegistry,
    private readonly onCorrectiveResponse?: ((event: { turn: number; reasonCode: string }) => void) | undefined,
    private readonly finalEvidenceGate?: ((event: { turn: number }) => boolean) | undefined,
  ) {}

  async start(input: AgentRunSpec): Promise<AgentRunView> {
    const spec = validateSpec(input)
    const runId = opaqueRef('run')
    const record: HarnessRunRecord = {
      protocol: HARNESS_RUN_PROTOCOL,
      runId,
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
    }
    this.runs.set(runId, record)
    this.tools.bindRun?.(runId, spec.toolBinding)
    return publicView(record)
  }

  async read(runId: string): Promise<AgentRunView | null> {
    let record = this.runs.get(runId)
    if (!record) return null
    this.tools.bindRun?.(record.runId, record.spec.toolBinding)
    try {
      if (record.phase === 'discovering_tools') record = await this.discoverTools(record)
      else if (record.phase === 'submitting_provider') record = await this.submitPending(record)
      else if (record.phase === 'awaiting_provider') record = await this.readProvider(record)
      else if (record.phase === 'cancelling_provider') record = await this.cancelProvider(record)
      else if (record.phase === 'executing_batch') record = await this.executeAndContinue(record)
      return publicView(record)
    } catch (error) {
      if (isInterventionRequiredError(error)) throw error
      return publicView(this.fail(record, error))
    }
  }

  async resume(runId: string, intervention: AgentRunIntervention): Promise<AgentRunView> {
    let record = this.required(runId)
    this.tools.bindRun?.(record.runId, record.spec.toolBinding)
    try {
      if (isTerminal(record.status)) return publicView(record)
      if (record.providerTurn?.lifecycle === 'waiting_for_user') {
        throw new HarnessSkillError(
          'harness_provider_restart_required',
          'Provider intervention cannot resume this run; start a new run after completing the visible step.',
        )
      } else if (record.status === 'waiting_for_approval') {
        const approvals = new Map((intervention.approvals ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.approval !== 'pending') return call
          if (hasFailedDependency(record, call)) return { ...call, approval: 'not_required' as const }
          if (approvals.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_approval_invalid', `Approval for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, approval: 'approved' as const }
        })
        record = this.update(runId, (current) => ({ ...current, status: 'running', phase: 'executing_batch', calls }))
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
        record = this.update(runId, (current) => ({ ...current, status: 'running', phase: 'executing_batch', needs }))
      } else if (record.status === 'waiting_for_authentication') {
        const completed = new Map((intervention.authenticationCompleted ?? []).map((item) => [item.callId, item.argumentsDigest]))
        const calls = record.calls.map((call) => {
          if (call.status !== 'authentication_required') return call
          if (completed.get(call.id) !== call.argumentsDigest) {
            throw new HarnessSkillError('harness_auth_resume_invalid', `Authentication resume for call '${call.id}' does not match its frozen arguments.`)
          }
          return { ...call, status: 'pending' as const, handoff: undefined }
        })
        record = this.update(runId, (current) => ({ ...current, status: 'running', phase: 'executing_batch', calls }))
      } else {
        throw new HarnessSkillError('harness_run_not_resumable', 'Harness run is not waiting for a supported intervention.')
      }
      return publicView(record)
    } catch (error) {
      if (isInterventionRequiredError(error)) throw error
      return publicView(this.fail(record, error))
    }
  }

  async cancel(runId: string): Promise<AgentRunView> {
    let record = this.required(runId)
    this.tools.bindRun?.(record.runId, record.spec.toolBinding)
    if (isTerminal(record.status)) return publicView(record)
    try {
      if (record.phase === 'submitting_provider' && record.providerTurn?.requestRef !== record.requestRef) {
        record = this.update(runId, (current) => ({
          ...current,
          phase: 'cancelling_provider',
          pendingProviderOperation: { kind: 'cancel', requestRef: current.requestRef },
        }))
        record = await this.cancelProvider(record)
      } else if (record.providerTurn && ['queued', 'running', 'waiting_for_user'].includes(record.providerTurn.lifecycle)) {
        record = this.update(runId, (current) => ({
          ...current,
          phase: 'cancelling_provider',
          pendingProviderOperation: { kind: 'cancel', requestRef: current.requestRef, turnRef: current.providerTurn!.turnRef },
        }))
        record = await this.cancelProvider(record)
      } else {
        record = this.update(runId, (current) => ({ ...current, status: 'cancelled', phase: 'terminal' }))
      }
      return publicView(record)
    } catch (error) {
      return publicView(this.fail(record, error))
    }
  }

  async close() {
    this.runs.clear()
    await this.tools.close?.()
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
      assertProviderTurnIdentity(record, cancellation.turn)
      const terminal = cancellation.turn.lifecycle === 'cancelled' || cancellation.turn.lifecycle === 'failed'
      return this.update(record.runId, (current) => ({
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
      return this.fail(record, error)
    }
  }

  private async discoverTools(record: HarnessRunRecord) {
    const catalog = await this.tools.catalog(record.spec.mcpServers ?? [], {
      runId: record.runId,
      ...(record.spec.workspaceRoot ? { workspaceRoot: record.spec.workspaceRoot } : {}),
    })
    const pendingProviderRequest = providerRequest({ ...record, catalog })
    return this.update(record.runId, (current) => ({
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
    return this.update(record.runId, (current) => ({
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

    const acceptActionBatch = (batch: HarnessActionBatch) => {
      const batchId = sha256({ runId: record.runId, turn: record.turn, nonce: record.nonce, batch })
      const reasonCode = syntheticReissueReasonCode(batch)
      const storedCalls = batch.calls.map((call) => harnessCall(record, batchId, call, this.tools))
      const storedBatch: HarnessActionBatch = {
        ...batch,
        calls: batch.calls.map((call, index) => ({ ...call, arguments: storedCalls[index]!.arguments })),
      }
      const storedProviderTurn = record.spec.toolBinding
        ? redactProviderActionTurn(providerTurn, storedBatch)
        : { ...providerTurn, modelResponse: storedBatch }
      const resolved = resolveKnownDependencyFailures(storedCalls)
      const calls = resolved.calls
      const callResults = resolved.callResults
      const needs = batch.needs.map((need) => ({ id: need.id, prompt: need.prompt, inputSchema: need.inputSchema }))
      const status = needs.length > 0
        ? 'waiting_for_input'
        : calls.some((call) => call.approval === 'pending' && !hasFailedDependencyInResults(call, callResults))
          ? 'waiting_for_approval'
          : 'running'
      const next = this.update(record.runId, (current) => ({
        ...current,
        providerTurn: storedProviderTurn,
        batch: storedBatch,
        batchId,
        calls,
        needs,
        callResults,
        needResults: [],
        status,
        phase: status === 'running' ? 'executing_batch' : 'waiting_intervention',
      }))
      if (reasonCode !== null) this.onCorrectiveResponse?.({ turn: record.turn, reasonCode })
      return next
    }

    if (response.kind === 'final') {
      if (this.finalEvidenceGate && !this.finalEvidenceGate({ turn: record.turn })) {
        return acceptActionBatch(malformedBenchmarkEvidenceActionBatch(record.runId, record.turn, record.nonce))
      }
      const storedFinal = this.tools.redactFinal?.(response, { runId: record.runId, turn: record.turn }) ?? response
      const storedProviderTurn = storedFinal === response
        ? providerTurn
        : redactProviderFinalTurn(providerTurn, storedFinal)
      return this.update(record.runId, (current) => ({
        ...current,
        providerTurn: storedProviderTurn,
        status: 'succeeded',
        phase: 'terminal',
        final: storedFinal,
      }))
    }
    return acceptActionBatch(response)
  }

  private async executeAndContinue(record: HarnessRunRecord): Promise<HarnessRunRecord> {
    if (!record.batch || !record.batchId) throw new HarnessSkillError('harness_batch_missing', 'Harness run has no action batch to resume.')
    const batch = record.batch
    const batchId = record.batchId
    if (record.needs.some((need) => need.answer === undefined)) {
      return this.waitFor(record, 'waiting_for_input')
    }

    let progressed: boolean
    do {
      progressed = false
      for (const call of record.calls) {
        if (call.status !== 'pending') continue
        const dependencies = call.dependsOn.map((id) => record.callResults.find((result) => result.id === id))
        if (dependencies.some((result) => result?.status === 'failed')) {
          record = this.recordCallOutcome(record, call.id, 'failed', { code: 'harness_tool_dependency_failed' })
          progressed = true
          continue
        }
        if (dependencies.some((result) => result === undefined)) continue
        if (call.approval === 'pending') continue
        if (call.approval !== 'approved' && call.approval !== 'not_required') {
          throw new HarnessSkillError('harness_approval_state_invalid', `Call '${call.id}' is not authorized for execution.`)
        }
        const entry = record.catalog.find((tool) => tool.name === call.tool)
        if (!entry) {
          record = this.recordCallOutcome(record, call.id, 'failed', { code: 'harness_tool_not_in_frozen_catalog' })
          progressed = true
          continue
        }
        const executionContext = {
          runId: record.runId,
          callId: call.id,
          argumentsDigest: call.argumentsDigest,
          ...(record.spec.workspaceRoot ? { workspaceRoot: record.spec.workspaceRoot } : {}),
        }
        let executionArguments: JsonValue
        try {
          executionArguments = this.tools.restoreArguments?.(entry, call.arguments, executionContext) ?? call.arguments
          validateHarnessArguments(entry, executionArguments)
        } catch (error) {
          record = this.recordCallOutcome(record, call.id, 'failed', harnessArgumentFailure(error, call.tool))
          progressed = true
          continue
        }
        record = this.update(record.runId, (current) => ({
          ...current,
          calls: current.calls.map((candidate) => candidate.id === call.id ? { ...candidate, status: 'executing' } : candidate),
        }))
        try {
          const outcome = await this.tools.execute(
            entry,
            executionArguments as Record<string, JsonValue>,
            record.spec.mcpServers ?? [],
            executionContext,
          )
          if (outcome.status === 'authentication_required') {
            record = this.update(record.runId, (current) => ({
              ...current,
              calls: current.calls.map((candidate) => candidate.id === call.id
                ? { ...candidate, status: 'authentication_required', handoff: outcome.handoff }
                : candidate),
            }))
          } else {
            record = this.recordCallOutcome(record, call.id, outcome.status, outcome.content)
          }
        } catch (error) {
          record = this.recordCallOutcome(record, call.id, 'failed', harnessExecutionFailure(error))
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
    for (const call of record.calls.filter((candidate) => candidate.status === 'pending')) {
      record = this.recordCallOutcome(record, call.id, 'failed', { code: 'harness_tool_dependency_unavailable' })
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
    return this.update(record.runId, (current) => ({
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
    return this.update(record.runId, (current) => ({
      ...current,
      status,
      phase: 'waiting_intervention',
    }))
  }

  private async submitPending(record: HarnessRunRecord): Promise<HarnessRunRecord> {
    const pendingRequest = record.pendingProviderRequest
    if (!pendingRequest) throw new HarnessSkillError('harness_provider_intent_missing', 'Harness provider submission intent is missing.')
    const request = this.tools.prepareProviderRequest?.(pendingRequest, {
      runId: record.runId,
      turn: record.turn,
    }) ?? pendingRequest
    try {
      const providerTurn = request.continuation
        ? await this.provider.continue(request)
        : await this.provider.start(request)
      assertProviderTurnIdentity(record, providerTurn)
      return this.update(record.runId, (current) => ({
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
      return this.fail(record, error)
    }
  }

  private recordCallOutcome(record: HarnessRunRecord, callId: string, status: 'succeeded' | 'failed', content: JsonValue) {
    const call = record.calls.find((candidate) => candidate.id === callId)
    const entry = call ? record.catalog.find((candidate) => candidate.name === call.tool) : undefined
    const storedContent = call && entry
      ? this.tools.redactResult?.(entry, content, {
        runId: record.runId,
        callId: call.id,
        argumentsDigest: call.argumentsDigest,
      }) ?? content
      : content
    return this.update(record.runId, (current) => ({
      ...current,
      calls: current.calls.map((currentCall) => currentCall.id === callId ? { ...currentCall, status, outcome: storedContent } : currentCall),
      callResults: [...current.callResults.filter((result) => result.id !== callId), { id: callId, status, content: storedContent }],
    }))
  }

  private fail(record: HarnessRunRecord, error: unknown) {
    if (isTerminal(record.status)) return record
    const safe = error instanceof HarnessSkillError || error instanceof ProviderTurnDispatchError
      ? { code: error.code, message: error.message }
      : { code: 'harness_run_failed', message: 'Harness run failed.' }
    return this.update(record.runId, (current) => ({
      ...current,
      status: 'failed',
      phase: 'terminal',
      pendingProviderRequest: undefined,
      pendingProviderOperation: undefined,
      error: safe,
    }))
  }

  private required(runId: string) {
    const record = this.runs.get(runId)
    if (!record) throw new HarnessSkillError('harness_run_missing', 'Harness run does not exist.')
    return record
  }

  private update(runId: string, mutate: (current: HarnessRunRecord) => HarnessRunRecord) {
    const record = { ...mutate(this.required(runId)), protocol: HARNESS_RUN_PROTOCOL, runId }
    this.runs.set(runId, record)
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

function redactProviderActionTurn(providerTurn: ProviderTurnState, batch: HarnessActionBatch): ProviderTurnState {
  const { responseText: _responseText, ...redacted } = providerTurn
  return { ...redacted, modelResponse: batch }
}

function redactProviderFinalTurn(providerTurn: ProviderTurnState, final: HarnessFinalResponse): ProviderTurnState {
  const { responseText: _responseText, ...redacted } = providerTurn
  return { ...redacted, modelResponse: final }
}

function harnessCall(
  record: HarnessRunRecord,
  batchId: string,
  call: HarnessActionBatch['calls'][number],
  tools: HarnessToolRegistry,
): HarnessCall {
  const argumentsDigest = sha256({
    runId: record.runId,
    turn: record.turn,
    nonce: record.nonce,
    batchId,
    callId: call.id,
    tool: call.tool,
    arguments: call.arguments,
  })
  const entry = record.catalog.find((tool) => tool.name === call.tool)
  if (!entry && call.validationError === undefined) {
    throw new HarnessSkillError('harness_tool_unknown', `Tool '${call.tool}' is absent from the frozen catalog.`)
  }
  if (call.validationError) {
    return {
      id: call.id,
      tool: call.tool,
      arguments: record.spec.toolBinding
        ? { redacted: true, sha256: sha256(call.arguments) }
        : call.arguments,
      argumentsDigest,
      dependsOn: call.dependsOn ?? [],
      approval: 'not_required',
      status: 'failed',
      outcome: {
        code: call.validationError.code,
        message: call.validationError.message,
        ...(call.validationError.details === undefined ? {} : { details: call.validationError.details }),
      },
    }
  }
  if (!entry) throw new HarnessSkillError('harness_tool_unknown', `Tool '${call.tool}' is absent from the frozen catalog.`)
  const storedArguments = tools.redactArguments?.(entry, call.arguments, {
    runId: record.runId,
    callId: call.id,
    argumentsDigest,
  }) ?? call.arguments
  const requiresApproval = entry.approval === 'always' || (!entry.readOnly && !isTrustedWorkspaceExecution(entry))
  return {
    id: call.id,
    tool: call.tool,
    arguments: storedArguments,
    argumentsDigest,
    dependsOn: call.dependsOn ?? [],
    approval: requiresApproval ? 'pending' : 'not_required',
    status: 'pending',
  }
}

function isTrustedWorkspaceExecution(entry: HarnessToolCatalogEntry) {
  return entry.source === 'local'
    && entry.server === 'tokenless-workspace'
    && entry.serverToolName === 'exec'
    && entry.name === 'workspace.exec'
    && entry.readOnly === false
    && entry.approval === 'allow_trusted'
}

function resolveKnownDependencyFailures(calls: readonly HarnessCall[]) {
  const resolved = calls.map((call) => ({ ...call }))
  const callResults = resolved
    .filter((call) => call.status === 'failed' && call.outcome !== undefined)
    .map((call) => ({ id: call.id, status: 'failed' as const, content: call.outcome! }))
  let changed = true
  while (changed) {
    changed = false
    const failedIds = new Set(callResults.map((result) => result.id))
    for (const [index, call] of resolved.entries()) {
      if (call.status !== 'pending' || !call.dependsOn.some((dependency) => failedIds.has(dependency))) continue
      const outcome = { code: 'harness_tool_dependency_failed' as const }
      resolved[index] = { ...call, approval: 'not_required', status: 'failed', outcome }
      callResults.push({ id: call.id, status: 'failed', content: outcome })
      changed = true
    }
  }
  const resultsById = new Map(callResults.map((result) => [result.id, result]))
  return {
    calls: resolved,
    callResults: resolved.flatMap((call) => {
      const result = resultsById.get(call.id)
      return result ? [result] : []
    }),
  }
}

function validateHarnessArguments(entry: HarnessToolCatalogEntry, value: JsonValue) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessSkillError('harness_tool_arguments_invalid', `Arguments for tool '${entry.name}' must be a JSON object.`)
  }
  validateJsonSchemaValue(entry.inputSchema, value, `Arguments for tool '${entry.name}'`)
}

function harnessArgumentFailure(error: unknown, tool: string): JsonValue {
  if (error instanceof HarnessSkillError) {
    return {
      code: 'harness_tool_arguments_invalid',
      message: error.message,
      ...(error.context?.issues === undefined ? {} : { details: { issues: error.context.issues } }),
    }
  }
  return { code: 'harness_tool_arguments_invalid', message: `Arguments for tool '${tool}' failed frozen-schema validation.` }
}

function harnessExecutionFailure(error: unknown): JsonValue {
  if (error instanceof HarnessSkillError && error.code.startsWith('harness_workspace_')) {
    return { code: error.code, message: error.message }
  }
  return { code: 'harness_tool_execution_failed' }
}

function publicView(record: HarnessRunRecord): AgentRunView {
  const waiting = record.status === 'waiting_for_approval'
    ? {
        kind: 'approval' as const,
        calls: record.calls
          .filter((call) => call.approval === 'pending' && !hasFailedDependency(record, call))
          .map(publicCall),
      }
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

function publicCall(call: HarnessCall): {
  id: string
  tool: string
  arguments: Record<string, JsonValue>
  argumentsDigest: string
} {
  return {
    id: call.id,
    tool: call.tool,
    arguments: call.arguments as Record<string, JsonValue>,
    argumentsDigest: call.argumentsDigest,
  }
}

function hasFailedDependency(record: HarnessRunRecord, call: HarnessCall) {
  return hasFailedDependencyInResults(call, record.callResults)
}

function hasFailedDependencyInResults(
  call: Pick<HarnessCall, 'dependsOn'>,
  results: readonly { id: string; status: 'succeeded' | 'failed' }[],
) {
  const statuses = new Map(results.map((result) => [result.id, result.status]))
  return call.dependsOn.some((dependency) => statuses.get(dependency) === 'failed')
}

function validateSpec(input: AgentRunSpec): AgentRunSpec {
  if (!isRecord(input)) throw new HarnessSkillError('harness_spec_invalid', 'Agent run spec must be a JSON object.')
  assertExactKeys(input, [
    'provider', 'profileId', 'taskPrompt', 'stagingRoot', 'selectedSkills',
    'finalOutput', 'limits', 'maxTurns', 'mcpServers', 'toolBinding', 'workspaceRoot',
  ], 'Agent run spec')
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.provider)) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run provider is invalid.')
  }
  if (typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.profileId)) throw new HarnessSkillError('harness_spec_invalid', 'Agent run profileId is invalid.')
  if (typeof input.taskPrompt !== 'string' || input.taskPrompt.trim() === '' || Buffer.byteLength(input.taskPrompt, 'utf8') > 64 * 1024) throw new HarnessSkillError('harness_spec_invalid', 'Agent run taskPrompt is invalid.')
  if (typeof input.stagingRoot !== 'string' || input.stagingRoot.trim() === '' || input.stagingRoot.includes('\0')) throw new HarnessSkillError('harness_spec_invalid', 'Agent run stagingRoot is invalid.')
  if (!Number.isSafeInteger(input.maxTurns ?? 8) || (input.maxTurns ?? 8) < 1 || (input.maxTurns ?? 8) > 64) throw new HarnessSkillError('harness_spec_invalid', 'Agent run maxTurns must be 1-64.')
  const selectedSkills = sanitizeSelectedSkills(input.selectedSkills)
  const finalOutput = sanitizeFinalOutput(input.finalOutput)
  const limits = sanitizeLimits(input.limits)
  const mcpServers = sanitizeMcpServers(input.mcpServers)
  const toolBinding = sanitizeToolBinding(input.toolBinding)
  const workspaceRoot = sanitizeWorkspaceRoot(input.workspaceRoot)
  return {
    provider: input.provider,
    profileId: input.profileId,
    taskPrompt: input.taskPrompt,
    stagingRoot: input.stagingRoot,
    ...(selectedSkills ? { selectedSkills } : {}),
    ...(finalOutput ? { finalOutput } : {}),
    ...(limits ? { limits } : {}),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    mcpServers,
    ...(toolBinding ? { toolBinding } : {}),
  }
}

function sanitizeToolBinding(value: unknown): AgentRunSpec['toolBinding'] {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.kind !== 'opaque' || typeof value.ref !== 'string' ||
    !/^extension-session:[A-Za-z0-9_-]{16,128}$/u.test(value.ref)) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run toolBinding is invalid.')
  }
  assertExactKeys(value, ['kind', 'ref'], 'toolBinding')
  return { kind: 'opaque', ref: value.ref }
}

function sanitizeWorkspaceRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new HarnessSkillError('harness_spec_invalid', 'Agent run workspaceRoot must be an absolute path.')
  }
  return path.normalize(value)
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
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider turn does not match the request identity.')
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

function assertProviderCancellationIdentity(requestRef: string, cancellation: import('../contracts.js').ProviderTurnCancellation) {
  if (cancellation.protocol !== PROVIDER_TURN_PROTOCOL || cancellation.requestRef !== requestRef ||
    (cancellation.kind === 'turn' && cancellation.turn.requestRef !== requestRef)) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Provider cancellation does not match the request identity.')
  }
}

function assertModelResponseIdentity(record: HarnessRunRecord, response: HarnessActionBatch | import('../contracts.js').HarnessFinalResponse) {
  if (response.runId !== record.runId || response.turn !== record.turn || response.nonce !== record.nonce) {
    throw new HarnessSkillError('harness_provider_response_identity_mismatch', 'Provider response does not match the run turn and nonce.')
  }
}

function isTerminal(status: string) { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function isInterventionRequiredError(error: unknown) {
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
