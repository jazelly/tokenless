import path from 'node:path'

import {
  HARNESS_SKILL_STATE_PROTOCOL,
  HarnessSkillError,
  type HarnessAttachment,
  type HarnessFinalOutputContract,
  type HarnessToolDescriptor,
  type JsonValue,
  type SkillDeliveryRevision,
} from '../contracts.js'
import { readJsonFile, writePrivateJsonAtomic } from './filesystem.js'
import type { ResolvedHarnessSkillLimits } from './limits.js'
import type { InternalSkillRecord } from '../skill-runtime/registry.js'

export type HarnessSkillState = {
  protocol: typeof HARNESS_SKILL_STATE_PROTOCOL
  runId: string
  skillRoot: string | null
  limits: ResolvedHarnessSkillLimits
  registrySha256: string
  registry: readonly InternalSkillRecord[]
  tools: readonly HarnessToolDescriptor[]
  finalOutput: HarnessFinalOutputContract
  systemPrompt: HarnessAttachment
  loadedSkills: readonly { name: string; sha256: string }[]
  deliveryRevision: number
  nextTurn: number
  deliveries: readonly SkillDeliveryRevision[]
}

export function statePath(runDirectory: string) {
  return path.join(runDirectory, 'state.json')
}

export async function writeHarnessSkillState(runDirectory: string, state: HarnessSkillState) {
  await writePrivateJsonAtomic(statePath(runDirectory), state as unknown as JsonValue)
}

export async function readHarnessSkillState(runDirectory: string, expectedRunId: string) {
  const value = await readJsonFile(statePath(runDirectory))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness Skill state must be a JSON object.')
  }
  const state = value as Partial<HarnessSkillState>
  if (state.protocol !== HARNESS_SKILL_STATE_PROTOCOL || state.runId !== expectedRunId) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness Skill state protocol or run identity does not match.')
  }
  if (
    !state.limits ||
    !Array.isArray(state.registry) ||
    !Array.isArray(state.tools) ||
    !state.systemPrompt ||
    !Array.isArray(state.loadedSkills) ||
    !Array.isArray(state.deliveries) ||
    !Number.isSafeInteger(state.deliveryRevision) ||
    !Number.isSafeInteger(state.nextTurn) ||
    typeof state.registrySha256 !== 'string'
  ) {
    throw new HarnessSkillError('harness_state_invalid', 'Harness Skill state is incomplete.')
  }
  return state as HarnessSkillState
}
