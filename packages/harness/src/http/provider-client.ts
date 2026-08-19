import type { TurnState } from 'tokenless-internal-contracts/private/provider-turn'
import { LocalHttpError, createLocalHttpClient } from 'tokenless-internal-contracts/private/provider-turn-http'

import {
  PROVIDER_TURN_PROTOCOL,
  HarnessSkillError,
  ProviderTurnDispatchError,
  type ProviderTurnClient,
  type ProviderTurnRequest,
  type ProviderTurnState,
} from '../contracts.js'
import {
  cancelHarnessLocalHttpTurn,
  completeHarnessLocalHttpBootstrap,
  completeHarnessLocalHttpContinuation,
  continueHarnessLocalHttpTurn,
  readHarnessLocalHttpTurn,
  startHarnessLocalHttpBootstrap,
} from './bootstrap.js'

export function createLocalHttpProviderTurnClient(options: { baseUrl: string; token: string }): ProviderTurnClient {
  return {
    async start(request) {
      if (request.continuation) throw new HarnessSkillError('harness_provider_request_invalid', 'Provider start cannot contain a continuation.')
      const binding = await createLocalHttpClient(options).bind(request.provider, request.profileId)
      return dispatch(async () => {
        const turn = await startHarnessLocalHttpBootstrap({
          baseUrl: options.baseUrl,
          token: options.token,
          provider: request.provider,
          profileId: request.profileId,
          requestRef: request.requestRef,
          runId: request.runId,
          stagingRoot: request.stagingRoot,
          ...(request.selectedSkills ? { selectedSkills: request.selectedSkills } : {}),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.finalOutput ? { finalOutput: request.finalOutput } : {}),
          ...(request.limits ? { limits: request.limits } : {}),
          taskPrompt: request.taskPrompt ?? '',
          nonce: request.nonce,
        })
        return project(request, turn, undefined, {
          providerRef: binding.capabilities.providerRef,
          providerBindingRef: binding.providerBindingRef,
        })
      })
    },

    async continue(request) {
      if (!request.continuation) throw new HarnessSkillError('harness_provider_request_invalid', 'Provider continuation is missing.')
      const continuation = request.continuation
      return dispatch(async () => {
        const started = await continueHarnessLocalHttpTurn({
          baseUrl: options.baseUrl,
          token: options.token,
          providerBindingRef: continuation.providerBindingRef,
          providerRef: continuation.providerRef,
          conversationRef: continuation.conversationRef,
          requestRef: request.requestRef,
          runId: request.runId,
          stagingRoot: request.stagingRoot,
          turn: request.turn,
          nonce: request.nonce,
          resultText: JSON.stringify(continuation.result),
          skillLoads: continuation.skillLoads,
        })
        return project(request, started.turnState, started.resultSha256, continuation)
      })
    },

    async read(request) {
      const raw = await dispatch(() => readHarnessLocalHttpTurn({ baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef }))
      if (raw.lifecycle !== 'succeeded') return project(request, raw, request.expectedDeliverySha256, request)
      if (request.turn === 1) {
        const completed = await dispatch(() => completeHarnessLocalHttpBootstrap({
          baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef,
          runId: request.runId, stagingRoot: request.stagingRoot, nonce: request.nonce,
        }))
        return { ...project(request, completed.turnState, undefined, request), modelResponse: completed.response }
      }
      const resultSha256 = request.expectedDeliverySha256
      if (!resultSha256) throw new HarnessSkillError('harness_provider_delivery_missing', 'Continuation delivery digest is missing.')
      const completed = await dispatch(() => completeHarnessLocalHttpContinuation({
        baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef,
        runId: request.runId, stagingRoot: request.stagingRoot, turn: request.turn,
        nonce: request.nonce, resultSha256,
      }))
      return { ...project(request, completed.turnState, resultSha256, request), modelResponse: completed.response }
    },

    async resume(request) {
      const client = createLocalHttpClient(options)
      const current = await dispatch(() => client.read(request.turnRef))
      if (current.lifecycle !== 'waiting_for_user') return project(request, current, request.expectedDeliverySha256, request)
      const turn = await dispatch(() => client.resume(request.turnRef))
      return project(request, turn, request.expectedDeliverySha256, request)
    },

    async cancel(request) {
      const client = createLocalHttpClient(options)
      if (request.turnRef) {
        const current = await dispatch(() => client.read(request.turnRef!))
        if (current.lifecycle === 'cancelled' || current.lifecycle === 'failed' || current.lifecycle === 'succeeded') {
          return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'turn', turn: project(request, current, undefined, request) }
        }
        const turn = await dispatch(() => cancelHarnessLocalHttpTurn({ baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef! }))
        return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'turn', turn: project(request, turn, undefined, request) }
      }
      const cancellation = await dispatch(() => client.cancelRequest(request.requestRef))
      if (cancellation.kind === 'cancelled_before_start') {
        return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'cancelled_before_start' }
      }
      const turn = await dispatch(() => client.read(cancellation.turn.turnRef))
      return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'turn', turn: project(request, turn) }
    },
  }
}

async function dispatch<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProviderTurnDispatchError) throw error
    if (error instanceof LocalHttpError) {
      throw new ProviderTurnDispatchError(
        error.error?.retryable ? 'ambiguous' : 'deterministic',
        error.error?.code ?? 'harness_provider_http_error',
        error.error?.message ?? 'Local provider dispatch failed.',
      )
    }
    if (error instanceof HarnessSkillError) {
      throw new ProviderTurnDispatchError('deterministic', 'harness_provider_dispatch_invalid', 'Local provider dispatch was rejected before acceptance.')
    }
    throw new ProviderTurnDispatchError('ambiguous', 'harness_provider_dispatch_ambiguous', 'Local provider dispatch outcome is ambiguous.')
  }
}

function project(
  request: Pick<ProviderTurnRequest, 'requestRef' | 'runId' | 'turn' | 'nonce' | 'provider' | 'profileId'>,
  turn: TurnState,
  deliverySha256?: string,
  expected?: { providerRef?: string | undefined; providerBindingRef?: string | undefined; conversationRef?: string | undefined },
): ProviderTurnState {
  if (turn.requestRef !== request.requestRef ||
    (expected?.providerRef !== undefined && turn.providerRef !== expected.providerRef) ||
    (expected?.providerBindingRef !== undefined && turn.providerBindingRef !== expected.providerBindingRef) ||
    (expected?.conversationRef !== undefined && turn.conversationRef !== expected.conversationRef)) {
    throw new HarnessSkillError('harness_provider_identity_mismatch', 'Local provider returned a mismatched raw turn identity.')
  }
  return {
    protocol: PROVIDER_TURN_PROTOCOL,
    requestRef: turn.requestRef,
    runId: request.runId,
    turn: request.turn,
    nonce: request.nonce,
    provider: request.provider,
    profileId: request.profileId,
    turnRef: turn.turnRef,
    providerRef: turn.providerRef,
    providerBindingRef: turn.providerBindingRef,
    conversationRef: turn.conversationRef,
    lifecycle: turn.lifecycle,
    ...(deliverySha256 ? { deliverySha256 } : {}),
    ...(turn.lifecycle === 'waiting_for_user' ? { waitingReason: turn.waitingReason } : {}),
    ...(turn.lifecycle === 'succeeded' ? { responseText: turn.result.text } : {}),
    ...(turn.lifecycle === 'failed' ? { error: turn.error } : {}),
  }
}
