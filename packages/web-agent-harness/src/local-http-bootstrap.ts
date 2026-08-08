import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { StartTurnRequest, TurnState } from 'tokenless-web-ai-interaction-protocol'

import {
  HarnessSkillError,
  type ReadHarnessLocalHttpTurnInput,
  type StartHarnessLocalHttpBootstrapInput,
} from './contracts.js'
import { renderPromptManifest } from './internal/system-prompt.js'
import {
  assertHarnessBootstrapStaticInput,
  prepareHarnessBootstrapTurn,
  renderHarnessBootstrapPrompt,
} from './skill-harness.js'

const REQUIRED_CAPABILITIES = ['conversation.chat', 'file.upload'] as const
const MAX_V0_SYSTEM_PROMPT_BYTES = 1024 * 1024

/**
 * Starts one V0 new-conversation turn with the compiled System Prompt.
 * Queued transport state is not visible-provider attachment acceptance.
 */
export async function startHarnessLocalHttpBootstrap(
  input: StartHarnessLocalHttpBootstrapInput,
): Promise<TurnState> {
  assertSupportedStaticInput(input)
  assertHarnessBootstrapStaticInput(input)

  const { createLocalHttpClient } = await import('tokenless-web-ai-interaction-protocol/local-http')
  const client = createLocalHttpClient({ baseUrl: input.baseUrl, token: input.token })
  const binding = await client.bind(input.provider, input.profileId)
  assertRequiredCapabilities(binding.capabilities.supportedCapabilities)

  const preparation = await prepareHarnessBootstrapTurn({
    runId: input.runId,
    stagingRoot: input.stagingRoot,
    ...(input.skillRoot === undefined ? {} : { skillRoot: input.skillRoot }),
    ...(input.finalOutput === undefined ? {} : { finalOutput: input.finalOutput }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    taskPrompt: input.taskPrompt,
    nonce: input.nonce,
  })
  if (preparation.candidateDelivery.attachments.length !== 0) {
    throw new HarnessSkillError('harness_bootstrap_skills_unsupported', 'V0 local HTTP bootstrap accepts only the required System Prompt.')
  }
  if (preparation.systemPrompt.size > MAX_V0_SYSTEM_PROMPT_BYTES) {
    throw new HarnessSkillError('harness_system_prompt_too_large', 'The compiled System Prompt exceeds the V0 local HTTP attachment limit.')
  }
  const bootstrapText = renderHarnessBootstrapPrompt({
    runId: preparation.runId,
    nonce: preparation.nonce,
    taskPrompt: input.taskPrompt,
    promptManifest: renderPromptManifest({
      systemPromptName: preparation.systemPrompt.name,
      skillAttachments: [],
      registrySha256: preparation.registry.sha256,
      deliverySha256: preparation.candidateDelivery.sha256,
    }),
  })
  assertV0BootstrapText(bootstrapText)

  const bytes = await readFile(preparation.systemPrompt.sourcePath)
  const attachment = await client.stage(binding.providerBindingRef, bytes)
  if (attachment.byteLength !== preparation.systemPrompt.size || attachment.sha256 !== preparation.systemPrompt.sha256) {
    throw new HarnessSkillError('harness_system_prompt_stage_mismatch', 'The local daemon staged a System Prompt with an unexpected identity.')
  }

  const request = await canonicalStartRequest({
    requestRef: `request:${randomBytes(16).toString('hex')}`,
    providerRef: binding.capabilities.providerRef,
    providerBindingRef: binding.providerBindingRef,
    text: bootstrapText,
    attachment,
  })
  return client.start(binding.providerBindingRef, request)
}

export async function readHarnessLocalHttpTurn(input: ReadHarnessLocalHttpTurnInput): Promise<TurnState> {
  const { createLocalHttpClient } = await import('tokenless-web-ai-interaction-protocol/local-http')
  return createLocalHttpClient({ baseUrl: input.baseUrl, token: input.token }).read(input.turnRef)
}

export async function cancelHarnessLocalHttpTurn(input: ReadHarnessLocalHttpTurnInput): Promise<TurnState> {
  const { createLocalHttpClient } = await import('tokenless-web-ai-interaction-protocol/local-http')
  return createLocalHttpClient({ baseUrl: input.baseUrl, token: input.token }).cancel(input.turnRef)
}

function assertSupportedStaticInput(input: StartHarnessLocalHttpBootstrapInput) {
  const value = input.selectedSkills
  if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) {
    throw new HarnessSkillError('harness_bootstrap_skills_unsupported', 'V0 local HTTP bootstrap does not support selected Skills.')
  }
  if (Object.hasOwn(input, 'tools')) {
    throw new HarnessSkillError('harness_bootstrap_tools_unsupported', 'V0 local HTTP bootstrap does not support tools or MCP.')
  }
}

function assertRequiredCapabilities(capabilities: readonly string[]) {
  if (capabilities.length !== REQUIRED_CAPABILITIES.length || REQUIRED_CAPABILITIES.some((capability) => !capabilities.includes(capability))) {
    throw new HarnessSkillError(
      'harness_provider_capabilities_unsupported',
      'V0 local HTTP bootstrap requires conversation.chat and file.upload.',
    )
  }
}

function assertV0BootstrapText(value: string) {
  if (Array.from(value).length > 4_000 || Buffer.byteLength(value, 'utf8') > 8 * 1024) {
    throw new HarnessSkillError('harness_bootstrap_message_too_large', 'V0 local HTTP bootstrap text exceeds protocol limits.')
  }
}

async function canonicalStartRequest({
  requestRef,
  providerRef,
  providerBindingRef,
  text,
  attachment,
}: {
  requestRef: string
  providerRef: string
  providerBindingRef: string
  text: string
  attachment: { attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }
}): Promise<StartTurnRequest> {
  const { WEB_AI_INTERACTION_PROTOCOL_V0, parseStartTurnRequest } = await import('tokenless-web-ai-interaction-protocol')
  return parseStartTurnRequest({
    protocol: WEB_AI_INTERACTION_PROTOCOL_V0,
    requestRef,
    providerRef,
    providerBindingRef,
    requiredCapabilities: REQUIRED_CAPABILITIES,
    conversation: { mode: 'new' },
    bootstrap: {
      text,
      attachments: [{
        kind: 'system_prompt',
        attachmentRef: attachment.attachmentRef,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      }],
    },
  })
}
