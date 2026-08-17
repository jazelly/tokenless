import type { TurnState } from 'tokenless-web-ai-interaction-protocol'
import { LocalHttpError, createLocalHttpClient } from 'tokenless-web-ai-interaction-protocol/local-http'

import {
  PROVIDER_TURN_PROTOCOL,
  HarnessSkillError,
  ProviderTurnDispatchError,
  type ProviderTurnClient,
  type ProviderTurnRequest,
  type ProviderTurnState,
} from './contracts.js'
import {
  cancelHarnessLocalHttpTurn,
  completeHarnessLocalHttpBootstrap,
  completeHarnessLocalHttpContinuation,
  continueHarnessLocalHttpTurn,
  readHarnessLocalHttpTurn,
  startHarnessLocalHttpBootstrap,
} from './local-http-bootstrap.js'

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
          taskPrompt: request.taskPrompt ?? '',
          nonce: request.nonce,
        })
        return project(request.requestRef, turn)
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
        return project(request.requestRef, started.turnState, started.resultSha256)
      })
    },

    async read(request) {
      const raw = await readHarnessLocalHttpTurn({ baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef })
      if (raw.lifecycle !== 'succeeded') return project(request.requestRef, raw, request.expectedDeliverySha256)
      if (request.turn === 1) {
        const completed = await completeHarnessLocalHttpBootstrap({
          baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef,
          runId: request.runId, stagingRoot: request.stagingRoot, nonce: request.nonce,
        })
        return { ...project(request.requestRef, completed.turnState), modelResponse: completed.response }
      }
      if (!request.expectedDeliverySha256) throw new HarnessSkillError('harness_provider_delivery_missing', 'Continuation delivery digest is missing.')
      const completed = await completeHarnessLocalHttpContinuation({
        baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef,
        runId: request.runId, stagingRoot: request.stagingRoot, turn: request.turn,
        nonce: request.nonce, resultSha256: request.expectedDeliverySha256,
      })
      return { ...project(request.requestRef, completed.turnState, request.expectedDeliverySha256), modelResponse: completed.response }
    },

    async resume(request) {
      const turn = await createLocalHttpClient(options).resume(request.turnRef)
      return project(request.requestRef, turn, request.expectedDeliverySha256)
    },

    async cancel(request) {
      if (request.turnRef) {
        const turn = await cancelHarnessLocalHttpTurn({ baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef })
        return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'turn', turn: project(request.requestRef, turn) }
      }
      const client = createLocalHttpClient(options)
      const cancellation = await client.cancelRequest(request.requestRef)
      if (cancellation.kind === 'cancelled_before_start') {
        return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'cancelled_before_start' }
      }
      const turn = await client.read(cancellation.turn.turnRef)
      return { protocol: PROVIDER_TURN_PROTOCOL, requestRef: request.requestRef, kind: 'turn', turn: project(request.requestRef, turn) }
    },
  }
}

async function dispatch<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof LocalHttpError) {
      throw new ProviderTurnDispatchError(
        error.error?.retryable ? 'ambiguous' : 'deterministic',
        error.error?.code ?? 'harness_provider_http_error',
        error.error?.message ?? 'Local provider dispatch failed.',
      )
    }
    if (error instanceof HarnessSkillError || error instanceof TypeError) {
      throw new ProviderTurnDispatchError('deterministic', 'harness_provider_dispatch_invalid', 'Local provider dispatch was rejected before acceptance.')
    }
    throw new ProviderTurnDispatchError('ambiguous', 'harness_provider_dispatch_ambiguous', 'Local provider dispatch outcome is ambiguous.')
  }
}

function project(requestRef: string, turn: TurnState, deliverySha256?: string): ProviderTurnState {
  return {
    protocol: PROVIDER_TURN_PROTOCOL,
    requestRef,
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
