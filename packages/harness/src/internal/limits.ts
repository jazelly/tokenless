import { HarnessSkillError, type HarnessSkillLimits } from '../contracts.js'

export type ResolvedHarnessSkillLimits = {
  maxSkills: number
  maxRegistryBytes: number
  maxFrontmatterBytes: number
  maxSkillFileBytes: number
  maxSkillAttachmentsPerTurn: number
  maxSkillAttachmentBytesPerTurn: number
}

export const DEFAULT_HARNESS_SKILL_LIMITS: ResolvedHarnessSkillLimits = Object.freeze({
  maxSkills: 256,
  maxRegistryBytes: 256 * 1024,
  maxFrontmatterBytes: 64 * 1024,
  maxSkillFileBytes: 512 * 1024,
  maxSkillAttachmentsPerTurn: 32,
  maxSkillAttachmentBytesPerTurn: 8 * 1024 * 1024,
})

export function resolveHarnessSkillLimits(value: HarnessSkillLimits | undefined): ResolvedHarnessSkillLimits {
  return {
    maxSkills: positiveInteger(value?.maxSkills, 'limits.maxSkills', DEFAULT_HARNESS_SKILL_LIMITS.maxSkills),
    maxRegistryBytes: positiveInteger(
      value?.maxRegistryBytes,
      'limits.maxRegistryBytes',
      DEFAULT_HARNESS_SKILL_LIMITS.maxRegistryBytes,
    ),
    maxFrontmatterBytes: positiveInteger(
      value?.maxFrontmatterBytes,
      'limits.maxFrontmatterBytes',
      DEFAULT_HARNESS_SKILL_LIMITS.maxFrontmatterBytes,
    ),
    maxSkillFileBytes: positiveInteger(
      value?.maxSkillFileBytes,
      'limits.maxSkillFileBytes',
      DEFAULT_HARNESS_SKILL_LIMITS.maxSkillFileBytes,
    ),
    maxSkillAttachmentsPerTurn: positiveInteger(
      value?.maxSkillAttachmentsPerTurn,
      'limits.maxSkillAttachmentsPerTurn',
      DEFAULT_HARNESS_SKILL_LIMITS.maxSkillAttachmentsPerTurn,
    ),
    maxSkillAttachmentBytesPerTurn: positiveInteger(
      value?.maxSkillAttachmentBytesPerTurn,
      'limits.maxSkillAttachmentBytesPerTurn',
      DEFAULT_HARNESS_SKILL_LIMITS.maxSkillAttachmentBytesPerTurn,
    ),
  }
}

function positiveInteger(value: number | undefined, label: string, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HarnessSkillError('invalid_limit', `${label} must be a positive safe integer.`)
  }
  return value
}
