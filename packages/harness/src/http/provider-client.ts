import type { TurnState } from './provider-turn/index.js'
import { LocalHttpError, createLocalHttpClient } from './provider-turn/http-client.js'

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
          ...(request.semanticPreference === undefined ? {} : { semanticPreference: request.semanticPreference }),
          taskPrompt: request.taskPrompt ?? '',
          nonce: request.nonce,
          ...(request.payloadLifetime === undefined ? {} : { payloadLifetime: request.payloadLifetime }),
        })
        return project(request, turn)
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
          ...(request.payloadLifetime === undefined ? {} : { payloadLifetime: request.payloadLifetime }),
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
        error.error?.code ?? 'harness_provider_http_error',
        error.error?.message ?? 'Local provider dispatch failed.',
      )
    }
    if (error instanceof HarnessSkillError) {
      throw new ProviderTurnDispatchError(error.code, error.message)
    }
    throw new ProviderTurnDispatchError('harness_provider_dispatch_failed', 'Local provider dispatch failed.')
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
    ...(turn.lifecycle === 'succeeded' && turn.result ? { responseText: turn.result.text } : {}),
    ...(turn.lifecycle === 'failed' ? { error: turn.error } : {}),
  }
}
