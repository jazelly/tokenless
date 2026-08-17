import type { TurnState } from 'tokenless-web-ai-interaction-protocol'

import {
  PROVIDER_TURN_PROTOCOL,
  HarnessSkillError,
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
    },

    async continue(request) {
      if (!request.continuation) throw new HarnessSkillError('harness_provider_request_invalid', 'Provider continuation is missing.')
      const started = await continueHarnessLocalHttpTurn({
        baseUrl: options.baseUrl,
        token: options.token,
        providerBindingRef: request.continuation.providerBindingRef,
        providerRef: request.continuation.providerRef,
        conversationRef: request.continuation.conversationRef,
        requestRef: request.requestRef,
        runId: request.runId,
        stagingRoot: request.stagingRoot,
        turn: request.turn,
        nonce: request.nonce,
        resultText: JSON.stringify(request.continuation.result),
        skillLoads: request.continuation.skillLoads,
      })
      return project(request.requestRef, started.turnState, started.resultSha256)
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
      const { createLocalHttpClient } = await import('tokenless-web-ai-interaction-protocol/local-http')
      const turn = await createLocalHttpClient(options).resume(request.turnRef)
      return project(request.requestRef, turn, request.expectedDeliverySha256)
    },

    async cancel(request) {
      const turn = await cancelHarnessLocalHttpTurn({ baseUrl: options.baseUrl, token: options.token, turnRef: request.turnRef })
      return project(request.requestRef, turn)
    },
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
