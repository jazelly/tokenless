import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  HARNESS_SKILL_MODULE_PROTOCOL,
  REQUIRED_HARNESS_PROVIDER_CAPABILITIES,
  HarnessSkillError,
  type HarnessAttachment,
  type HarnessFinalOutputContract,
  type HarnessSkillRunPreparation,
  type HarnessSkillTurnPreparation,
  type ParseHarnessModelResponseInput,
  type PrepareHarnessSkillRunInput,
  type PrepareHarnessSkillTurnInput,
  type SkillDeliveryOmission,
  type SkillDeliveryRevision,
  type SkillSelection,
} from './contracts.js'
import {
  createRunDirectory,
  ensureTurnDirectory,
  readRegularFile,
  resolveRunDirectory,
  sha256,
  writePrivateFile,
} from './internal/filesystem.js'
import { resolveHarnessSkillLimits } from './internal/limits.js'
import { assertValidJsonSchema } from './internal/json-schema.js'
import { parseModelResponse } from './internal/model-response.js'
import {
  discoverSkillRegistry,
  parseSkillFrontmatter,
  validateSkillMetadata,
  type InternalSkillRecord,
} from './internal/skill-registry.js'
import {
  compileHarnessSystemPrompt,
  renderPromptManifest,
  validateToolCatalog,
} from './internal/system-prompt.js'
import {
  readHarnessSkillState,
  writeHarnessSkillState,
  type HarnessSkillState,
} from './internal/state.js'

const MARKDOWN_MEDIA_TYPE = 'text/markdown' as const
const MAX_SYSTEM_PROMPT_BYTES = 2 * 1024 * 1024
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export async function prepareHarnessSkillRun(
  input: PrepareHarnessSkillRunInput,
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
    const delivery = await stageSkillDelivery({
      state: initialState,
      runDirectory,
      turn: 0,
      revision: 0,
      selections: normalizeSelections(input.selectedSkills ?? []),
    })
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
  const state = await readHarnessSkillState(runDirectory, input.runId)
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
  const state = await readHarnessSkillState(runDirectory, input.runId)
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
