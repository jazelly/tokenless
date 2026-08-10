import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { StartTurnRequest, TurnState } from 'tokenless-web-ai-interaction-protocol'

import {
  HarnessSkillError,
  type CompleteHarnessLocalHttpBootstrapInput,
  type HarnessBootstrapTurn,
  type HarnessLocalHttpBootstrapCompletion,
  type ReadHarnessLocalHttpTurnInput,
  type StartHarnessLocalHttpBootstrapInput,
} from './contracts.js'
import { renderPromptManifest } from './internal/system-prompt.js'
import {
  assertHarnessBootstrapStaticInput,
  finalizeHarnessBootstrapTurn,
  prepareHarnessBootstrapTurn,
  readHarnessBootstrapCandidates,
  renderHarnessBootstrapPrompt,
  validateHarnessBootstrapCompletionResponse,
} from './skill-harness.js'

const REQUIRED_CAPABILITIES = ['conversation.chat', 'file.upload'] as const
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_CHROME_BYTES = 256
const OPEN_MARKER = '<TOKENLESS_HARNESS_RESPONSE>'
const CLOSE_MARKER = '</TOKENLESS_HARNESS_RESPONSE>'

/**
 * Starts one V0 new-conversation turn with the compiled System Prompt and
 * caller-selected Skill documents as independent files in one upload action.
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
    ...(input.selectedSkills === undefined ? {} : { selectedSkills: input.selectedSkills }),
    ...(input.finalOutput === undefined ? {} : { finalOutput: input.finalOutput }),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    taskPrompt: input.taskPrompt,
    nonce: input.nonce,
  })
  const bootstrapText = renderHarnessBootstrapPrompt({
    runId: preparation.runId,
    nonce: preparation.nonce,
    taskPrompt: input.taskPrompt,
    promptManifest: renderPromptManifest({
      systemPromptName: preparation.systemPrompt.name,
      skillAttachments: preparation.candidateDelivery.attachments,
      registrySha256: preparation.registry.sha256,
      deliverySha256: preparation.candidateDelivery.sha256,
    }),
  })
  assertV0BootstrapText(bootstrapText)

  const attachments = await stageHarnessAttachments(client, binding.providerBindingRef, preparation.attachments)

  const request = await canonicalStartRequest({
    requestRef: `request:${randomBytes(16).toString('hex')}`,
    providerRef: binding.capabilities.providerRef,
    providerBindingRef: binding.providerBindingRef,
    text: bootstrapText,
    attachments,
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

export async function completeHarnessLocalHttpBootstrap(
  input: CompleteHarnessLocalHttpBootstrapInput,
): Promise<HarnessLocalHttpBootstrapCompletion> {
  const turnState = await readHarnessLocalHttpTurn(input)
  if (
    turnState.lifecycle !== 'succeeded' ||
    turnState.dispatchCertainty !== 'dispatched' ||
    turnState.attachmentDelivery.status !== 'delivered' ||
    turnState.result.text.trim() === ''
  ) {
    throw new HarnessSkillError(
      'harness_bootstrap_turn_incomplete',
      'The local provider turn has not succeeded with delivered Harness context evidence.',
    )
  }

  const responseText = normalizeProviderResponse(turnState.result.text)
  const candidates = await readHarnessBootstrapCandidates({
    runId: input.runId,
    stagingRoot: input.stagingRoot,
    nonce: input.nonce,
  })
  const validated = await validateHarnessBootstrapCompletionResponse({
    runId: input.runId,
    stagingRoot: input.stagingRoot,
    responseText,
    turn: 1,
    nonce: input.nonce,
  })
  if (turnState.attachmentDelivery.sha256 !== candidates[0]!.sha256) {
    throw new HarnessSkillError(
      'harness_system_prompt_delivery_mismatch',
      'The delivered attachment batch does not match the pending Harness System Prompt.',
    )
  }

  const bootstrap = await finalizeHarnessBootstrapTurn({
    runId: input.runId,
    stagingRoot: input.stagingRoot,
    nonce: input.nonce,
    attachmentAcceptances: candidates.map((candidate) => ({
      name: candidate.name,
      sha256: candidate.sha256,
      accepted: true,
    })),
  })
  return {
    turnState,
    bootstrap: publicFinalizedBootstrap(bootstrap),
    response: validated.response,
  }
}

function assertSupportedStaticInput(input: StartHarnessLocalHttpBootstrapInput) {
  if (Object.hasOwn(input, 'tools')) {
    throw new HarnessSkillError('harness_bootstrap_tools_unsupported', 'V0 local HTTP bootstrap does not support tools or MCP.')
  }
}

async function stageHarnessAttachments(
  client: ReturnType<typeof import('tokenless-web-ai-interaction-protocol/local-http')['createLocalHttpClient']>,
  providerBindingRef: string,
  attachments: readonly {
  kind: 'system_prompt' | 'skill'
  name: string
  sourcePath: string
  size: number
  sha256: string
  skillName?: string | undefined
  }[],
) {
  const staged = []
  let bundleWith: string | undefined
  for (const attachment of attachments) {
    const bytes = await readFile(attachment.sourcePath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== attachment.size || digest !== attachment.sha256) {
      throw new HarnessSkillError('harness_context_source_changed', `Harness context source '${attachment.name}' changed after preparation.`)
    }
    const transport = await client.stage(providerBindingRef, bytes, {
      name: attachment.name,
      ...(bundleWith === undefined ? {} : { bundleWith }),
    })
    if (transport.byteLength !== bytes.byteLength || transport.sha256 !== attachment.sha256) {
      throw new HarnessSkillError('harness_attachment_stage_mismatch', `The local daemon staged Harness attachment '${attachment.name}' with an unexpected identity.`)
    }
    bundleWith ??= transport.attachmentRef
    staged.push({
      kind: attachment.kind,
      name: attachment.name,
      attachmentRef: transport.attachmentRef,
      mediaType: transport.mediaType,
      byteLength: transport.byteLength,
      sha256: transport.sha256,
    })
  }
  return staged as [{ kind: 'system_prompt'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }, ...Array<{ kind: 'skill'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }>]
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

function normalizeProviderResponse(value: string) {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new HarnessSkillError('harness_response_too_large', `Harness response must be at most ${MAX_PROVIDER_RESPONSE_BYTES} bytes.`)
  }
  if (value.startsWith(OPEN_MARKER) && value.endsWith(CLOSE_MARKER)) return value

  if (countOccurrences(value, OPEN_MARKER) !== 1 || countOccurrences(value, CLOSE_MARKER) !== 1) {
    throw new HarnessSkillError('harness_response_framing_invalid', 'Provider response must contain exactly one Harness response envelope.')
  }
  const open = value.indexOf(OPEN_MARKER)
  const close = value.indexOf(CLOSE_MARKER)
  if (open < 0 || close < open + OPEN_MARKER.length) {
    throw new HarnessSkillError('harness_response_framing_invalid', 'Provider response Harness markers are not ordered.')
  }
  assertBoundedProviderChrome(value.slice(0, open))
  assertBoundedProviderChrome(value.slice(close + CLOSE_MARKER.length))
  return value.slice(open, close + CLOSE_MARKER.length)
}

function assertBoundedProviderChrome(value: string) {
  if (
    Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_CHROME_BYTES ||
    /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new HarnessSkillError('harness_response_framing_invalid', 'Provider response chrome is not a bounded single line.')
  }
}

function countOccurrences(value: string, pattern: string) {
  return value.split(pattern).length - 1
}

function publicFinalizedBootstrap(bootstrap: HarnessBootstrapTurn) {
  return {
    protocol: bootstrap.protocol,
    kind: bootstrap.kind,
    status: 'finalized' as const,
    runId: bootstrap.runId,
    turn: bootstrap.turn,
    nonce: bootstrap.nonce,
    systemPrompt: {
      kind: bootstrap.systemPrompt.kind,
      name: bootstrap.systemPrompt.name,
      mediaType: bootstrap.systemPrompt.mediaType,
      size: bootstrap.systemPrompt.size,
      sha256: bootstrap.systemPrompt.sha256,
    },
    skills: bootstrap.acceptedAttachments
      .filter((attachment) => attachment.kind === 'skill')
      .map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sha256: attachment.sha256,
        skillName: attachment.skillName,
      })),
    promptManifest: bootstrap.promptManifest,
  }
}

async function canonicalStartRequest({
  requestRef,
  providerRef,
  providerBindingRef,
  text,
  attachments,
}: {
  requestRef: string
  providerRef: string
  providerBindingRef: string
  text: string
  attachments: readonly [{ kind: 'system_prompt'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }, ...Array<{ kind: 'skill'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }>]
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
      attachments,
    },
  })
}
