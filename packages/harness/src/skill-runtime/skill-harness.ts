import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  HARNESS_SKILL_MODULE_PROTOCOL,
  REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
  WEB_AGENT_PROTOCOL,
  HarnessSkillError,
  type HarnessAttachment,
  type HarnessBootstrapAttachmentAcceptance,
  type HarnessBootstrapTurn,
  type HarnessBootstrapTurnPreparation,
  type FinalizeHarnessBootstrapTurnInput,
  type HarnessFinalOutputContract,
  type HarnessSkillRunPreparation,
  type HarnessSkillTurnPreparation,
  type JsonValue,
  type ParseHarnessModelResponseInput,
  type PrepareHarnessBootstrapTurnInput,
  type PrepareHarnessSkillRunInput,
  type PrepareHarnessSkillTurnInput,
  type SkillDeliveryOmission,
  type SkillDeliveryRevision,
  type SkillRegistryRevision,
  type SkillSelection,
} from '../contracts.js'
import {
  canonicalJson,
  createRunDirectory,
  ensureTurnDirectory,
  readRegularFile,
  resolveRunDirectory,
  sha256,
  validateRunId,
  writePrivateFile,
} from '../internal/filesystem.js'
import { resolveHarnessSkillLimits } from '../internal/limits.js'
import { assertValidJsonSchema } from '../internal/json-schema.js'
import { parseModelResponse } from '../internal/model-response.js'
import {
  discoverSkillRegistry,
  parseSkillFrontmatter,
  validateSkillMetadata,
  type InternalSkillRecord,
} from './registry.js'
import {
  compileHarnessSystemPrompt,
  renderPromptManifest,
  validateToolCatalog,
} from '../internal/system-prompt.js'
import {
  readHarnessSkillState,
  writeHarnessSkillState,
  type HarnessSkillState,
} from '../internal/state.js'

const MARKDOWN_MEDIA_TYPE = 'text/markdown' as const
const MAX_SYSTEM_PROMPT_BYTES = 2 * 1024 * 1024
const MAX_BOOTSTRAP_TASK_PROMPT_BYTES = 64 * 1024
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/
const SKILL_DELIVERY_OMISSION_CODES = new Set([
  'unknown_skill',
  'already_loaded',
  'duplicate_request',
  'invalid_request',
  'skill_changed',
  'skill_file_unsafe',
  'skill_file_too_large',
  'expected_revision_mismatch',
  'attachment_count_limit',
  'attachment_byte_limit',
  'attachment_write_failed',
  'provider_upload_failed',
])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

type BootstrapTurnState = {
  status: 'pending' | 'finalized'
  taskPrompt: string
  nonce: string
  registry: SkillRegistryRevision
  candidateDelivery: SkillDeliveryRevision
  candidateSources: readonly {
    name: string
    sha256: string
    selectedBy: SkillSelection['selectedBy']
  }[]
  acceptanceOutcomes?: readonly HarnessBootstrapAttachmentAcceptance[] | undefined
  delivery?: SkillDeliveryRevision | undefined
}

type HarnessSkillStateWithBootstrap = HarnessSkillState & {
  bootstrapTurn?: BootstrapTurnState | undefined
}

export async function prepareHarnessBootstrapTurn(
  input: PrepareHarnessBootstrapTurnInput,
): Promise<HarnessBootstrapTurnPreparation> {
  const { taskPrompt, nonce } = assertHarnessBootstrapStaticInput(input)
  const prepared = await prepareInitialHarnessSkillRun(input, { taskPrompt, nonce })
  return {
    protocol: HARNESS_SKILL_MODULE_PROTOCOL,
    kind: 'bootstrap_turn_preparation',
    runId: prepared.runId,
    turn: 1,
    nonce,
    requiredProviderCapabilities: prepared.requiredProviderCapabilities,
    attachments: [prepared.systemPrompt, ...prepared.delivery.attachments],
    runDirectory: prepared.runDirectory,
    registry: prepared.registry,
    systemPrompt: prepared.systemPrompt,
    candidateDelivery: prepared.delivery,
  }
}

export async function readHarnessBootstrapTurnPreparation(input: Pick<PrepareHarnessBootstrapTurnInput, 'runId' | 'stagingRoot' | 'taskPrompt' | 'nonce'>): Promise<HarnessBootstrapTurnPreparation> {
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  const bootstrap = readBootstrapTurn(state)
  if (bootstrap.taskPrompt !== input.taskPrompt || bootstrap.nonce !== input.nonce) {
    throw new HarnessSkillError('harness_bootstrap_replay_conflict', 'Bootstrap replay does not match the frozen task and nonce.')
  }
  return {
    protocol: HARNESS_SKILL_MODULE_PROTOCOL,
    kind: 'bootstrap_turn_preparation',
    runId: state.runId,
    turn: 1,
    nonce: bootstrap.nonce,
    requiredProviderCapabilities: REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
    attachments: [state.systemPrompt, ...bootstrap.candidateDelivery.attachments],
    runDirectory,
    registry: bootstrap.registry,
    systemPrompt: state.systemPrompt,
    candidateDelivery: bootstrap.candidateDelivery,
  }
}

export function assertHarnessBootstrapStaticInput(
  input: Pick<PrepareHarnessBootstrapTurnInput, 'runId' | 'taskPrompt' | 'nonce' | 'finalOutput' | 'limits'>,
) {
  validateRunId(input.runId)
  const taskPrompt = validateBootstrapTaskPrompt(input.taskPrompt)
  const nonce = validateBootstrapNonce(input.nonce)
  resolveHarnessSkillLimits(input.limits)
  validateFinalOutput(input.finalOutput)
  return { taskPrompt, nonce }
}

/** @deprecated Legacy staging-only API; use prepareHarnessBootstrapTurn and finalizeHarnessBootstrapTurn for a first provider turn. */
export async function prepareHarnessSkillRun(
  input: PrepareHarnessSkillRunInput,
): Promise<HarnessSkillRunPreparation> {
  return prepareInitialHarnessSkillRun(input)
}

export async function finalizeHarnessBootstrapTurn(
  input: FinalizeHarnessBootstrapTurnInput,
): Promise<HarnessBootstrapTurn> {
  const nonce = validateBootstrapNonce(input.nonce)
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  const bootstrap = readBootstrapTurn(state)
  if (nonce !== bootstrap.nonce) {
    throw new HarnessSkillError('harness_bootstrap_correlation_invalid', 'Bootstrap nonce does not match the pending turn.')
  }

  const candidates = [state.systemPrompt, ...bootstrap.candidateDelivery.attachments]
  const accepted = validateBootstrapAttachmentAcceptances(input.attachmentAcceptances, candidates)
  const acceptanceOutcomes = canonicalBootstrapAcceptanceOutcomes(candidates, accepted)
  if (bootstrap.status === 'finalized') {
    if (!bootstrap.delivery || !sameBootstrapAcceptanceOutcomes(bootstrap.acceptanceOutcomes, acceptanceOutcomes)) {
      throw new HarnessSkillError('harness_bootstrap_acceptance_conflict', 'Bootstrap acceptance outcomes conflict with the finalized turn.')
    }
    assertFinalizedBootstrapState(state, bootstrap)
    return buildFinalizedBootstrapTurn({ runDirectory, state, bootstrap })
  }
  if (!accepted.get(attachmentIdentity(state.systemPrompt))) {
    throw new HarnessSkillError(
      'harness_system_prompt_not_accepted',
      'The required Harness System Prompt was not visibly accepted by the provider.',
    )
  }

  const { acceptedSkills, delivery } = createFinalizedBootstrapDelivery(bootstrap, accepted)
  const finalizedBootstrap: BootstrapTurnState = {
    ...bootstrap,
    status: 'finalized',
    acceptanceOutcomes,
    delivery,
  }
  const finalizedState: HarnessSkillStateWithBootstrap = {
    ...state,
    loadedSkills: acceptedSkills.map((attachment) => ({
      name: attachment.skillName!,
      sha256: attachment.sha256,
    })),
    deliveryRevision: delivery.revision,
    deliveries: [...state.deliveries, delivery],
    bootstrapTurn: finalizedBootstrap,
  }
  await writeHarnessSkillState(runDirectory, finalizedState)
  return buildFinalizedBootstrapTurn({ runDirectory, state: finalizedState, bootstrap: finalizedBootstrap })
}

function buildFinalizedBootstrapTurn({
  runDirectory,
  state,
  bootstrap,
}: {
  runDirectory: string
  state: HarnessSkillStateWithBootstrap
  bootstrap: BootstrapTurnState
}): HarnessBootstrapTurn {
  const delivery = bootstrap.delivery!
  const promptManifest = renderPromptManifest({
    systemPromptName: state.systemPrompt.name,
    skillAttachments: delivery.attachments,
    registrySha256: state.registrySha256,
    deliverySha256: delivery.sha256,
  })
  return {
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'bootstrap_turn',
    runId: state.runId,
    turn: 1,
    nonce: bootstrap.nonce,
    requiredProviderCapabilities: REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
    acceptedAttachments: [state.systemPrompt, ...delivery.attachments],
    prompt: renderHarnessBootstrapPrompt({
      runId: state.runId,
      nonce: bootstrap.nonce,
      taskPrompt: bootstrap.taskPrompt,
      promptManifest,
    }),
    runDirectory,
    registry: bootstrap.registry,
    systemPrompt: state.systemPrompt,
    delivery,
    promptManifest,
  }
}

async function prepareInitialHarnessSkillRun(
  input: PrepareHarnessSkillRunInput,
  bootstrap?: Pick<BootstrapTurnState, 'taskPrompt' | 'nonce'>,
): Promise<HarnessSkillRunPreparation> {
  const limits = resolveHarnessSkillLimits(input.limits)
  const skillRoot = input.skillRoot ?? path.join(os.homedir(), '.agents', 'skills')
  const tools = validateToolCatalog(input.tools)
  const finalOutput = validateFinalOutput(input.finalOutput)
  const registry = await discoverSkillRegistry({ skillRoot, limits })
  const systemPromptContent = compileHarnessSystemPrompt({
    skills: registry.revision.skills,
    registrySha256: registry.revision.sha256,
    tools,
    finalOutput,
  })
  const systemPromptBytes = Buffer.byteLength(systemPromptContent, 'utf8')
  if (systemPromptBytes > MAX_SYSTEM_PROMPT_BYTES) {
    throw new HarnessSkillError(
      'system_prompt_too_large',
      `Compiled Harness System Prompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes.`,
    )
  }

  const runDirectory = await createRunDirectory(input.stagingRoot, input.runId)
  try {
    const turnDirectory = await ensureTurnDirectory(runDirectory, 0)
    const systemPromptSha256 = sha256(systemPromptContent)
    const systemPromptName = `tokenless-harness-system--${systemPromptSha256.slice(0, 12)}.md`
    const systemPromptPath = path.join(turnDirectory, systemPromptName)
    await writePrivateFile(systemPromptPath, systemPromptContent)
    const systemPrompt: HarnessAttachment = {
      kind: 'system_prompt',
      name: systemPromptName,
      sourcePath: systemPromptPath,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: systemPromptBytes,
      sha256: systemPromptSha256,
    }

    const initialState: HarnessSkillState = {
      protocol: 'tokenless.web-agent.skills-state/v1',
      runId: input.runId,
      skillRoot: registry.root,
      limits,
      registrySha256: registry.revision.sha256,
      registry: registry.records,
      tools,
      finalOutput,
      systemPrompt,
      loadedSkills: [],
      deliveryRevision: -1,
      nextTurn: 1,
      deliveries: [],
    }
    const selections = normalizeSelections(input.selectedSkills ?? [])
    const delivery = await stageSkillDelivery({
      state: initialState,
      runDirectory,
      turn: 0,
      revision: 0,
      selections,
    })
    if (bootstrap) {
      const pendingState: HarnessSkillStateWithBootstrap = {
        ...initialState,
        bootstrapTurn: {
          status: 'pending',
          ...bootstrap,
          registry: registry.revision,
          candidateDelivery: delivery,
          candidateSources: delivery.attachments.map((attachment) => ({
            name: attachment.name,
            sha256: attachment.sha256,
            selectedBy: selectionSourceForCandidate(attachment, selections),
          })),
        },
      }
      await writeHarnessSkillState(runDirectory, pendingState)
      return {
        protocol: HARNESS_SKILL_MODULE_PROTOCOL,
        runId: input.runId,
        runDirectory,
        requiredProviderCapabilities: REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
        registry: registry.revision,
        systemPrompt,
        delivery,
        promptManifest: '',
      }
    }
    const state: HarnessSkillState = {
      ...initialState,
      loadedSkills: delivery.attachments.map((attachment) => ({
        name: attachment.skillName!,
        sha256: attachment.sha256,
      })),
      deliveryRevision: 0,
      deliveries: [delivery],
    }
    await writeHarnessSkillState(runDirectory, state)
    return {
      protocol: HARNESS_SKILL_MODULE_PROTOCOL,
      runId: input.runId,
      runDirectory,
      requiredProviderCapabilities: REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
      registry: registry.revision,
      systemPrompt,
      delivery,
      promptManifest: renderPromptManifest({
        systemPromptName,
        skillAttachments: delivery.attachments,
        registrySha256: registry.revision.sha256,
        deliverySha256: delivery.sha256,
      }),
    }
  } catch (error) {
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function parseHarnessModelResponse(input: ParseHarnessModelResponseInput) {
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  assertBootstrapFinalized(state)
  return parseHarnessModelResponseFromState(input, state)
}

export async function validateHarnessBootstrapCompletionResponse(input: ParseHarnessModelResponseInput) {
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  const bootstrap = readBootstrapTurn(state)
  if (bootstrap.nonce !== input.nonce) {
    throw new HarnessSkillError('harness_bootstrap_correlation_invalid', 'Bootstrap nonce does not match the pending turn.')
  }
  if (!isSkillDeliveryRevision(bootstrap.candidateDelivery) || !isExactCandidateSources(bootstrap.candidateSources, bootstrap.candidateDelivery.attachments)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap candidate state is invalid.')
  }
  if (bootstrap.status === 'finalized') assertFinalizedBootstrapState(state, bootstrap)
  return {
    response: parseHarnessModelResponseFromState(input, state),
    systemPrompt: state.systemPrompt,
  }
}

export async function readHarnessBootstrapCandidates(input: {
  runId: string
  stagingRoot: string
  nonce: string
}): Promise<readonly HarnessAttachment[]> {
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  const bootstrap = readBootstrapTurn(state)
  if (bootstrap.nonce !== validateBootstrapNonce(input.nonce)) {
    throw new HarnessSkillError('harness_bootstrap_correlation_invalid', 'Bootstrap nonce does not match the pending turn.')
  }
  return [state.systemPrompt, ...bootstrap.candidateDelivery.attachments]
}

function parseHarnessModelResponseFromState(
  input: ParseHarnessModelResponseInput,
  state: HarnessSkillState,
) {
  if (input.turn !== state.nextTurn) {
    throw new HarnessSkillError(
      'harness_turn_unexpected',
      `Expected model turn ${state.nextTurn}, received ${input.turn}.`,
    )
  }
  return parseModelResponse({
    responseText: input.responseText,
    runId: input.runId,
    turn: input.turn,
    nonce: input.nonce,
    state,
  })
}

export async function prepareHarnessSkillTurn(
  input: PrepareHarnessSkillTurnInput,
): Promise<HarnessSkillTurnPreparation> {
  const runDirectory = await resolveRunDirectory(input.stagingRoot, input.runId)
  const state = await readHarnessSkillState(runDirectory, input.runId) as HarnessSkillStateWithBootstrap
  assertBootstrapFinalized(state)
  if (input.turn === state.nextTurn - 1) {
    const delivery = [...state.deliveries].reverse().find((candidate) => candidate.turn === input.turn)
    if (!delivery) throw new HarnessSkillError('harness_turn_replay_missing', 'Harness Skill delivery replay is unavailable.')
    return {
      protocol: HARNESS_SKILL_MODULE_PROTOCOL,
      runId: input.runId,
      runDirectory,
      delivery,
      promptManifest: renderPromptManifest({
        skillAttachments: delivery.attachments,
        registrySha256: state.registrySha256,
        deliverySha256: delivery.sha256,
      }),
    }
  }
  if (!Number.isSafeInteger(input.turn) || input.turn !== state.nextTurn) {
    throw new HarnessSkillError(
      'harness_turn_unexpected',
      `Expected Skill delivery for model turn ${state.nextTurn}, received ${input.turn}.`,
    )
  }
  const selections = [
    ...normalizeSelections(input.selectedSkills ?? []),
    ...(input.skillLoads ?? []).map((name) => ({ name, selectedBy: 'web_model' as const })),
  ]
  const delivery = await stageSkillDelivery({
    state,
    runDirectory,
    turn: input.turn,
    revision: state.deliveryRevision + 1,
    selections,
  })
  const newlyLoaded = delivery.attachments.map((attachment) => ({
    name: attachment.skillName!,
    sha256: attachment.sha256,
  }))
  await writeHarnessSkillState(runDirectory, {
    ...state,
    loadedSkills: [...state.loadedSkills, ...newlyLoaded],
    deliveryRevision: delivery.revision,
    nextTurn: state.nextTurn + 1,
    deliveries: [...state.deliveries, delivery],
  })
  return {
    protocol: HARNESS_SKILL_MODULE_PROTOCOL,
    runId: input.runId,
    runDirectory,
    delivery,
    promptManifest: renderPromptManifest({
      skillAttachments: delivery.attachments,
      registrySha256: state.registrySha256,
      deliverySha256: delivery.sha256,
    }),
  }
}

async function stageSkillDelivery({
  state,
  runDirectory,
  turn,
  revision,
  selections,
}: {
  state: HarnessSkillState
  runDirectory: string
  turn: number
  revision: number
  selections: readonly SkillSelection[]
}): Promise<SkillDeliveryRevision> {
  const attachments: HarnessAttachment[] = []
  const omissions: SkillDeliveryOmission[] = []
  const records = new Map(state.registry.map((record) => [record.name, record]))
  const loaded = new Set(state.loadedSkills.map((skill) => skill.name))
  const requested = new Set<string>()
  const turnDirectory = await ensureTurnDirectory(runDirectory, turn)
  let totalBytes = 0

  for (const selection of selections) {
    const name = selection.name
    if (!isValidSkillName(name) || !isSelectionSource(selection.selectedBy)) {
      omissions.push(omission(selection, 'invalid_request', 'Skill selection is not valid.'))
      continue
    }
    if (requested.has(name)) {
      omissions.push(omission(selection, 'duplicate_request', 'Skill was requested more than once in the same turn.'))
      continue
    }
    requested.add(name)
    if (loaded.has(name)) {
      omissions.push(omission(selection, 'already_loaded', 'Skill is already loaded in this run.'))
      continue
    }
    const record = records.get(name)
    if (!record || !state.skillRoot) {
      omissions.push(omission(selection, 'unknown_skill', 'Skill is not present in the frozen registry.'))
      continue
    }
    if (attachments.length >= state.limits.maxSkillAttachmentsPerTurn) {
      omissions.push(omission(selection, 'attachment_count_limit', 'Skill attachment count limit was reached.'))
      continue
    }

    let loadedSkill: { bytes: Buffer; sha256: string }
    try {
      loadedSkill = await loadRegisteredSkill({
        record,
        skillRoot: state.skillRoot,
        maxBytes: state.limits.maxSkillFileBytes,
      })
    } catch (error) {
      omissions.push(omissionFromError(selection, error))
      continue
    }
    const expectedSha256 = normalizeExpectedSha256(selection.expectedSha256)
    if (expectedSha256 && expectedSha256 !== loadedSkill.sha256) {
      omissions.push(omission(selection, 'expected_revision_mismatch', 'Skill content does not match expectedSha256.'))
      continue
    }
    if (totalBytes + loadedSkill.bytes.byteLength > state.limits.maxSkillAttachmentBytesPerTurn) {
      omissions.push(omission(selection, 'attachment_byte_limit', 'Skill attachment byte limit was reached.'))
      continue
    }

    const attachmentName = `tokenless-skill--${name}--${loadedSkill.sha256.slice(0, 12)}.md`
    const sourcePath = path.join(turnDirectory, attachmentName)
    try {
      await writePrivateFile(sourcePath, loadedSkill.bytes)
    } catch {
      omissions.push(omission(selection, 'attachment_write_failed', 'Skill could not be staged for upload.'))
      continue
    }
    attachments.push({
      kind: 'skill',
      name: attachmentName,
      sourcePath,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: loadedSkill.bytes.byteLength,
      sha256: loadedSkill.sha256,
      skillName: name,
    })
    totalBytes += loadedSkill.bytes.byteLength
  }

  return createSkillDeliveryRevision({ revision, turn, attachments, omissions })
}

function createSkillDeliveryRevision({
  revision,
  turn,
  attachments,
  omissions,
}: {
  revision: number
  turn: number
  attachments: readonly HarnessAttachment[]
  omissions: readonly SkillDeliveryOmission[]
}): SkillDeliveryRevision {
  const digest = sha256(JSON.stringify({
    revision,
    turn,
    attachments: attachments.map((attachment) => ({
      name: attachment.name,
      skillName: attachment.skillName,
      size: attachment.size,
      sha256: attachment.sha256,
    })),
    omissions: omissions.map(({ name, selectedBy, code }) => ({ name, selectedBy, code })),
  }))
  return { revision, turn, sha256: digest, attachments, omissions }
}

function readBootstrapTurn(state: HarnessSkillStateWithBootstrap): BootstrapTurnState {
  const bootstrap = state.bootstrapTurn
  if (!bootstrap || typeof bootstrap !== 'object' || !Array.isArray(bootstrap.candidateDelivery?.attachments)) {
    throw new HarnessSkillError('harness_bootstrap_missing', 'Harness run has no valid bootstrap turn.')
  }
  if (bootstrap.status !== 'pending' && bootstrap.status !== 'finalized') {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap state has an invalid status.')
  }
  if (
    typeof bootstrap.taskPrompt !== 'string' ||
    typeof bootstrap.nonce !== 'string' ||
    !Array.isArray(bootstrap.candidateSources) ||
    !bootstrap.registry ||
    typeof bootstrap.registry.sha256 !== 'string' ||
    !Array.isArray(bootstrap.registry.skills) ||
    !Array.isArray(bootstrap.registry.diagnostics)
  ) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap state is incomplete.')
  }
  return bootstrap
}

function assertBootstrapFinalized(state: HarnessSkillStateWithBootstrap) {
  if (!state.bootstrapTurn) return
  const bootstrap = readBootstrapTurn(state)
  if (bootstrap.status === 'pending') {
    throw new HarnessSkillError(
      'harness_bootstrap_pending',
      'Finalize the pending bootstrap attachment acceptance before preparing another provider turn.',
    )
  }
  assertFinalizedBootstrapState(state, bootstrap)
}

function assertFinalizedBootstrapState(
  state: HarnessSkillStateWithBootstrap,
  bootstrap: BootstrapTurnState,
) {
  const candidates = [state.systemPrompt, ...bootstrap.candidateDelivery.attachments]
  if (!isSkillDeliveryRevision(bootstrap.candidateDelivery) || !isExactCandidateSources(bootstrap.candidateSources, bootstrap.candidateDelivery.attachments)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap candidate state is invalid.')
  }
  let accepted: Map<string, boolean>
  try {
    accepted = validateBootstrapAttachmentAcceptances(bootstrap.acceptanceOutcomes, candidates)
  } catch {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap acceptance state is invalid.')
  }
  const canonicalOutcomes = canonicalBootstrapAcceptanceOutcomes(candidates, accepted)
  if (!sameBootstrapAcceptanceOutcomes(bootstrap.acceptanceOutcomes, canonicalOutcomes)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap acceptance outcomes are not canonical.')
  }
  if (accepted.get(attachmentIdentity(state.systemPrompt)) !== true) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap acceptance state rejects the required System Prompt.')
  }
  const { delivery: expectedDelivery } = createFinalizedBootstrapDelivery(bootstrap, accepted)
  if (!sameSkillDeliveryRevision(bootstrap.delivery, expectedDelivery)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness finalized bootstrap delivery is invalid.')
  }
  assertBootstrapDeliveryHistory(state, expectedDelivery)
}

function createFinalizedBootstrapDelivery(
  bootstrap: BootstrapTurnState,
  accepted: ReadonlyMap<string, boolean>,
) {
  const acceptedSkills = bootstrap.candidateDelivery.attachments.filter((attachment) => accepted.get(attachmentIdentity(attachment)))
  const sources = new Map(bootstrap.candidateSources.map((source) => [attachmentIdentity(source), source.selectedBy]))
  const providerOmissions = bootstrap.candidateDelivery.attachments
    .filter((attachment) => !accepted.get(attachmentIdentity(attachment)))
    .map((attachment) => omission(
      {
        name: attachment.skillName ?? '',
        selectedBy: sources.get(attachmentIdentity(attachment)) ?? 'caller_agent',
      },
      'provider_upload_failed',
      'Skill attachment was not visibly accepted by the provider.',
    ))
  return {
    acceptedSkills,
    delivery: createSkillDeliveryRevision({
      revision: bootstrap.candidateDelivery.revision,
      turn: bootstrap.candidateDelivery.turn,
      attachments: acceptedSkills,
      omissions: [...bootstrap.candidateDelivery.omissions, ...providerOmissions],
    }),
  }
}

function isSkillDeliveryRevision(value: unknown): value is SkillDeliveryRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const delivery = value as Partial<SkillDeliveryRevision>
  const revision = delivery.revision
  const turn = delivery.turn
  const sha256Value = delivery.sha256
  const attachments = delivery.attachments
  const omissions = delivery.omissions
  if (
    Object.keys(delivery).length === 5 &&
    typeof revision === 'number' && Number.isSafeInteger(revision) &&
    typeof turn === 'number' && Number.isSafeInteger(turn) &&
    typeof sha256Value === 'string' &&
    /^[a-f0-9]{64}$/.test(sha256Value) &&
    Array.isArray(attachments) &&
    Array.isArray(omissions) &&
    attachments.every(isStagedSkillAttachment) &&
    omissions.every(isSkillDeliveryOmission)
  ) {
    const expected = createSkillDeliveryRevision({
      revision,
      turn,
      attachments,
      omissions,
    })
    return sha256Value === expected.sha256
  }
  return false
}

function isStagedSkillAttachment(value: unknown): value is HarnessAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<HarnessAttachment>
  const size = attachment.size
  return (
    Object.keys(attachment).length === 7 &&
    attachment.kind === 'skill' &&
    typeof attachment.name === 'string' && attachment.name.length > 0 &&
    typeof attachment.sourcePath === 'string' && attachment.sourcePath.length > 0 &&
    attachment.mediaType === MARKDOWN_MEDIA_TYPE &&
    typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 &&
    typeof attachment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(attachment.sha256) &&
    typeof attachment.skillName === 'string' && isValidSkillName(attachment.skillName)
  )
}

function isSkillDeliveryOmission(value: unknown): value is SkillDeliveryOmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const omission = value as Partial<SkillDeliveryOmission>
  return (
    Object.keys(omission).length === 4 &&
    typeof omission.name === 'string' &&
    isSelectionSource(omission.selectedBy) &&
    typeof omission.code === 'string' && SKILL_DELIVERY_OMISSION_CODES.has(omission.code) &&
    typeof omission.message === 'string'
  )
}

function isExactCandidateSources(
  sources: readonly { name: string; sha256: string; selectedBy: SkillSelection['selectedBy'] }[],
  attachments: readonly HarnessAttachment[],
) {
  if (sources.length !== attachments.length) return false
  const expected = new Set(attachments.map(attachmentIdentity))
  const seen = new Set<string>()
  for (const source of sources) {
    if (!source || typeof source.name !== 'string' || typeof source.sha256 !== 'string' || !isSelectionSource(source.selectedBy)) {
      return false
    }
    const identity = attachmentIdentity(source)
    if (!expected.has(identity) || seen.has(identity)) return false
    seen.add(identity)
  }
  return seen.size === expected.size
}

function sameSkillDeliveryRevision(left: unknown, right: SkillDeliveryRevision) {
  return isSkillDeliveryRevision(left) && canonicalJson(left as unknown as JsonValue) === canonicalJson(right as unknown as JsonValue)
}

function assertBootstrapDeliveryHistory(state: HarnessSkillStateWithBootstrap, bootstrapDelivery: SkillDeliveryRevision) {
  if (!Array.isArray(state.deliveries) || state.deliveries.length === 0 || !sameSkillDeliveryRevision(state.deliveries[0], bootstrapDelivery)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness bootstrap delivery history is invalid.')
  }
  const loadedSkills: { name: string; sha256: string }[] = []
  const seenSkills = new Set<string>()
  let previous: SkillDeliveryRevision | undefined
  for (const delivery of state.deliveries) {
    if (!isSkillDeliveryRevision(delivery)) {
      throw new HarnessSkillError('harness_state_invalid', 'Harness delivery history contains an invalid delivery.')
    }
    if (previous && (delivery.revision !== previous.revision + 1 || delivery.turn !== previous.turn + 1)) {
      throw new HarnessSkillError('harness_state_invalid', 'Harness delivery history is not ordered by the recorded revision and turn sequence.')
    }
    for (const attachment of delivery.attachments) {
      if (!attachment.skillName || seenSkills.has(attachment.skillName)) {
        throw new HarnessSkillError('harness_state_invalid', 'Harness delivery history contains an invalid loaded Skill sequence.')
      }
      seenSkills.add(attachment.skillName)
      loadedSkills.push({ name: attachment.skillName, sha256: attachment.sha256 })
    }
    previous = delivery
  }
  if (!previous || state.deliveryRevision !== previous.revision || !sameLoadedSkills(state.loadedSkills, loadedSkills)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness loaded Skill state does not match delivery history.')
  }
}

function sameLoadedSkills(
  actual: readonly { name: string; sha256: string }[],
  expected: readonly { name: string; sha256: string }[],
) {
  return actual.length === expected.length && actual.every((skill, index) => {
    const expectedSkill = expected[index]
    return Boolean(expectedSkill && skill.name === expectedSkill.name && skill.sha256 === expectedSkill.sha256)
  })
}

function validateBootstrapAttachmentAcceptances(
  value: unknown,
  candidates: readonly HarnessAttachment[],
) {
  if (!Array.isArray(value) || value.length !== candidates.length || value.length > 257) {
    throw new HarnessSkillError('harness_bootstrap_acceptance_invalid', 'Acceptance outcomes must exactly cover the bounded bootstrap attachments.')
  }
  const expected = new Set(candidates.map(attachmentIdentity))
  const accepted = new Map<string, boolean>()
  for (const outcome of value) {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      throw new HarnessSkillError('harness_bootstrap_acceptance_invalid', 'Every bootstrap acceptance outcome must be an object.')
    }
    const record = outcome as Partial<HarnessBootstrapAttachmentAcceptance>
    if (
      Object.keys(record).length !== 3 ||
      typeof record.name !== 'string' ||
      typeof record.sha256 !== 'string' ||
      typeof record.accepted !== 'boolean'
    ) {
      throw new HarnessSkillError('harness_bootstrap_acceptance_invalid', 'Every bootstrap acceptance outcome must contain exact name, sha256, and accepted fields.')
    }
    const identity = attachmentIdentity(record as HarnessBootstrapAttachmentAcceptance)
    if (!expected.has(identity) || accepted.has(identity)) {
      throw new HarnessSkillError('harness_bootstrap_acceptance_invalid', 'Bootstrap acceptance outcome is unknown or duplicated.')
    }
    accepted.set(identity, record.accepted)
  }
  if (accepted.size !== expected.size) {
    throw new HarnessSkillError('harness_bootstrap_acceptance_invalid', 'Bootstrap acceptance outcomes are incomplete.')
  }
  return accepted
}

function canonicalBootstrapAcceptanceOutcomes(
  candidates: readonly HarnessAttachment[],
  accepted: ReadonlyMap<string, boolean>,
): readonly HarnessBootstrapAttachmentAcceptance[] {
  return candidates.map((attachment) => ({
    name: attachment.name,
    sha256: attachment.sha256,
    accepted: accepted.get(attachmentIdentity(attachment))!,
  }))
}

function sameBootstrapAcceptanceOutcomes(
  left: readonly HarnessBootstrapAttachmentAcceptance[] | undefined,
  right: readonly HarnessBootstrapAttachmentAcceptance[],
) {
  if (!left || left.length !== right.length) return false
  return left.every((outcome, index) => {
    const expected = right[index]
    return Boolean(
      expected &&
      outcome.name === expected.name &&
      outcome.sha256 === expected.sha256 &&
      outcome.accepted === expected.accepted,
    )
  })
}

function attachmentIdentity(attachment: Pick<HarnessAttachment, 'name' | 'sha256'>) {
  return `${attachment.name}\u0000${attachment.sha256}`
}

function selectionSourceForCandidate(
  attachment: HarnessAttachment,
  selections: readonly SkillSelection[],
): SkillSelection['selectedBy'] {
  return selections.find((selection) => (
    selection.name === attachment.skillName && isSelectionSource(selection.selectedBy)
  ))?.selectedBy ?? 'caller_agent'
}

export function renderHarnessBootstrapPrompt({
  runId,
  nonce,
  taskPrompt,
  promptManifest,
}: {
  runId: string
  nonce: string
  taskPrompt: string
  promptManifest: string
}) {
  return JSON.stringify({
    protocol: WEB_AGENT_PROTOCOL,
    kind: 'bootstrap_turn',
    runId,
    turn: 1,
    nonce,
    instruction: 'Read the attached Tokenless Harness instructions as the user-requested response format for this task. Follow provider system instructions and safety policies. Return the requested structured proposal without claiming to execute local tools yourself or answering the task directly.',
    task: {
      authority: 'untrusted_lower_priority_data',
      content: taskPrompt,
    },
    promptManifest,
  })
}

async function loadRegisteredSkill({
  record,
  skillRoot,
  maxBytes,
}: {
  record: InternalSkillRecord
  skillRoot: string
  maxBytes: number
}) {
  const { bytes } = await readRegularFile({ filePath: record.sourcePath, root: skillRoot, maxFileBytes: maxBytes })
  let text: string
  try {
    text = utf8Decoder.decode(bytes)
  } catch {
    throw new HarnessSkillError('skill_file_unsafe', 'Skill file must contain valid UTF-8 text.')
  }
  const metadata = validateSkillMetadata(parseSkillFrontmatter(text))
  if (metadata.name !== record.name || metadata.description !== record.description) {
    throw new HarnessSkillError('skill_changed', 'Skill selection metadata changed after the registry was frozen.')
  }
  return { bytes, sha256: sha256(bytes) }
}

function validateFinalOutput(value: HarnessFinalOutputContract | undefined): HarnessFinalOutputContract {
  if (value === undefined) return { kind: 'markdown' }
  if (value.kind === 'markdown') return { kind: 'markdown' }
  if (value.kind !== 'json_schema' || value.schema === undefined) {
    throw new HarnessSkillError('final_output_invalid', 'finalOutput must be markdown or json_schema with a schema.')
  }
  try {
    const serialized = JSON.stringify(value.schema)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new Error()
  } catch {
    throw new HarnessSkillError('final_output_invalid', 'finalOutput JSON Schema must be JSON-serializable and at most 262144 bytes.')
  }
  assertValidJsonSchema(value.schema, 'finalOutput.schema')
  return value
}

function validateBootstrapTaskPrompt(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > MAX_BOOTSTRAP_TASK_PROMPT_BYTES) {
    throw new HarnessSkillError(
      'task_prompt_invalid',
      `taskPrompt must be nonempty and at most ${MAX_BOOTSTRAP_TASK_PROMPT_BYTES} UTF-8 bytes.`,
    )
  }
  return value
}

function validateBootstrapNonce(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) {
    throw new HarnessSkillError('invalid_nonce', 'nonce must contain 8-256 characters.')
  }
  return value
}

function normalizeSelections(value: readonly SkillSelection[]) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new HarnessSkillError('skill_selection_invalid', 'selectedSkills must contain at most 256 items.')
  }
  return value.map((selection) => {
    if (!selection || typeof selection !== 'object') {
      return { name: '', selectedBy: 'caller_agent' as const }
    }
    return {
      name: typeof selection.name === 'string' ? selection.name : '',
      selectedBy: selection.selectedBy,
      ...(selection.expectedSha256 === undefined ? {} : { expectedSha256: selection.expectedSha256 }),
    }
  })
}

function omissionFromError(selection: SkillSelection, error: unknown): SkillDeliveryOmission {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'skill_file_too_large') {
      return omission(selection, 'skill_file_too_large', error instanceof Error ? error.message : 'Skill file is too large.')
    }
    if (error.code === 'skill_file_unsafe' || error.code === 'unsafe_path') {
      return omission(selection, 'skill_file_unsafe', error instanceof Error ? error.message : 'Skill file is unsafe.')
    }
    if (error.code === 'skill_changed' || error.code === 'skill_file_changed') {
      return omission(selection, 'skill_changed', error instanceof Error ? error.message : 'Skill changed after discovery.')
    }
  }
  return omission(selection, 'skill_changed', error instanceof Error ? error.message : 'Skill could not be loaded.')
}

function omission(
  selection: Pick<SkillSelection, 'name' | 'selectedBy'>,
  code: SkillDeliveryOmission['code'],
  message: string,
): SkillDeliveryOmission {
  return {
    name: typeof selection.name === 'string' ? selection.name : '',
    selectedBy: isSelectionSource(selection.selectedBy) ? selection.selectedBy : 'caller_agent',
    code,
    message,
  }
}

function normalizeExpectedSha256(value: string | undefined) {
  if (value === undefined) return undefined
  const match = SHA256_PATTERN.exec(value)
  return match?.[1] ?? '__invalid__'
}

function isValidSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isSelectionSource(value: unknown): value is SkillSelection['selectedBy'] {
  return value === 'explicit_user' || value === 'caller_agent' || value === 'web_model'
}
