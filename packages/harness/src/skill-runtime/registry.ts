import fs from 'node:fs/promises'
import path from 'node:path'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'

import type {
  SkillDescriptor,
  SkillRegistryDiagnostic,
  SkillRegistryRevision,
} from '../contracts.js'
import {
  isFileSystemError,
  readRegularFilePrefix,
  resolveOptionalSkillRoot,
  sha256,
} from '../internal/filesystem.js'
import type { ResolvedHarnessSkillLimits } from '../internal/limits.js'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type InternalSkillRecord = SkillDescriptor & {
  sourcePath: string
}

export type InternalSkillRegistry = {
  root: string | null
  revision: SkillRegistryRevision
  records: readonly InternalSkillRecord[]
}

export async function discoverSkillRegistry({
  skillRoot,
  limits,
}: {
  skillRoot: string
  limits: ResolvedHarnessSkillLimits
}): Promise<InternalSkillRegistry> {
  const resolvedRoot = await resolveOptionalSkillRoot(skillRoot)
  if (resolvedRoot.root === null) {
    const code = resolvedRoot.status === 'missing' ? 'skill_root_missing' : 'skill_root_unsafe'
    const diagnostics: SkillRegistryDiagnostic[] = [{
      candidate: path.basename(path.resolve(skillRoot)),
      code,
      message: resolvedRoot.status === 'missing'
        ? 'The configured global Skill root does not exist; the registry is empty.'
        : 'The configured global Skill root is not a regular, non-symlink directory; the registry is empty.',
    }]
    return registryResult(null, [], diagnostics)
  }

  const diagnostics: SkillRegistryDiagnostic[] = []
  const candidates: InternalSkillRecord[] = []
  const entries = (await fs.readdir(resolvedRoot.root, { withFileTypes: true }))
    .toSorted((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      diagnostics.push({
        candidate: entry.name,
        code: 'candidate_not_directory',
        message: 'Skill candidates must be regular, non-symlink directories.',
      })
      continue
    }

    const sourcePath = path.join(resolvedRoot.root, entry.name, 'SKILL.md')
    let parsed: SkillDescriptor
    try {
      const prefix = await readRegularFilePrefix({
        filePath: sourcePath,
        root: resolvedRoot.root,
        maxFileBytes: limits.maxSkillFileBytes,
        maxPrefixBytes: limits.maxFrontmatterBytes,
      })
      const frontmatter = parseSkillFrontmatter(prefix.text, prefix.prefixExceeded)
      parsed = validateSkillMetadata(frontmatter)
    } catch (error) {
      diagnostics.push(registryDiagnostic(entry.name, error))
      continue
    }

    if (parsed.name !== entry.name) {
      diagnostics.push({
        candidate: entry.name,
        code: 'directory_name_mismatch',
        message: `Skill name '${parsed.name}' does not match its parent directory '${entry.name}'; it was loaded by its declared name.`,
      })
    }
    candidates.push({ ...parsed, sourcePath })
  }

  const byName = new Map<string, InternalSkillRecord[]>()
  for (const candidate of candidates) {
    const group = byName.get(candidate.name) ?? []
    group.push(candidate)
    byName.set(candidate.name, group)
  }

  const unique: InternalSkillRecord[] = []
  for (const [name, group] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.length > 1) {
      for (const record of group) {
        diagnostics.push({
          candidate: path.basename(path.dirname(record.sourcePath)),
          code: 'duplicate_name',
          message: `Skill name '${name}' appears more than once and was omitted as ambiguous.`,
        })
      }
      continue
    }
    unique.push(group[0]!)
  }

  const accepted: InternalSkillRecord[] = []
  let registryBytes = 0
  for (const record of unique) {
    if (accepted.length >= limits.maxSkills) {
      diagnostics.push({
        candidate: record.name,
        code: 'registry_skill_limit',
        message: `Skill was omitted because the registry exceeds ${limits.maxSkills} entries.`,
      })
      continue
    }
    const entryBytes = Buffer.byteLength(JSON.stringify({ name: record.name, description: record.description }), 'utf8')
    if (registryBytes + entryBytes > limits.maxRegistryBytes) {
      diagnostics.push({
        candidate: record.name,
        code: 'registry_byte_limit',
        message: `Skill was omitted because the registry exceeds ${limits.maxRegistryBytes} bytes.`,
      })
      continue
    }
    registryBytes += entryBytes
    accepted.push(record)
  }

  return registryResult(resolvedRoot.root, accepted, diagnostics)
}

export function parseSkillFrontmatter(source: string, prefixExceeded = false) {
  const normalized = source.startsWith('\uFEFF') ? source.slice(1) : source
  const opening = /^(---)[\t ]*\r?\n/.exec(normalized)
  if (!opening) throw diagnosticError('frontmatter_missing', 'SKILL.md must start with YAML frontmatter.')
  const contentStart = opening[0].length
  const remainder = normalized.slice(contentStart)
  const closing = /\r?\n---[\t ]*(?:\r?\n|$)/.exec(remainder)
  if (!closing) {
    if (prefixExceeded) {
      throw diagnosticError('frontmatter_too_large', 'Skill frontmatter exceeds the configured byte limit.')
    }
    throw diagnosticError('frontmatter_missing', 'SKILL.md is missing the closing frontmatter delimiter.')
  }
  const yaml = remainder.slice(0, closing.index)
  let parsed: unknown
  try {
    parsed = parseYaml(yaml, { schema: JSON_SCHEMA })
  } catch {
    parsed = recoverCommonInvalidFrontmatter(yaml)
    if (!parsed) throw diagnosticError('frontmatter_invalid', 'Skill frontmatter is not valid YAML.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw diagnosticError('frontmatter_invalid', 'Skill frontmatter must be a YAML mapping.')
  }
  return parsed as Record<string, unknown>
}

function recoverCommonInvalidFrontmatter(source: string) {
  const lines = source.split(/\r?\n/)
  const nameLines = lines.filter((line) => /^name:[\t ]*/.test(line))
  const descriptionLines = lines.filter((line) => /^description:[\t ]*/.test(line))
  if (nameLines.length !== 1 || descriptionLines.length !== 1) return null
  let parsedName: unknown
  try {
    parsedName = parseYaml(nameLines[0]!, { schema: JSON_SCHEMA })
  } catch {
    return null
  }
  if (!parsedName || typeof parsedName !== 'object' || Array.isArray(parsedName)) return null
  const name = (parsedName as Record<string, unknown>).name
  const description = descriptionLines[0]!.slice(descriptionLines[0]!.indexOf(':') + 1).trim()
  if (typeof name !== 'string' || description === '' || description.startsWith('|') || description.startsWith('>')) {
    return null
  }
  return { name, description }
}

export function validateSkillMetadata(frontmatter: Record<string, unknown>): SkillDescriptor {
  const name = frontmatter.name
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > 64 ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    throw diagnosticError(
      'name_invalid',
      'Skill name must be 1-64 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen.',
    )
  }
  const description = frontmatter.description
  if (typeof description !== 'string' || description.trim() === '' || description.length > 1024) {
    throw diagnosticError('description_invalid', 'Skill description must be a nonempty string of at most 1024 characters.')
  }
  return { name, description: description.trim() }
}

function registryResult(
  root: string | null,
  records: readonly InternalSkillRecord[],
  diagnostics: readonly SkillRegistryDiagnostic[],
): InternalSkillRegistry {
  const skills = records.map(({ name, description }) => ({ name, description }))
  const revisionPayload = JSON.stringify(skills)
  return {
    root,
    records,
    revision: {
      sha256: sha256(revisionPayload),
      skills,
      diagnostics: [...diagnostics].sort((left, right) => (
        left.candidate.localeCompare(right.candidate) || left.code.localeCompare(right.code)
      )),
    },
  }
}

function registryDiagnostic(candidate: string, error: unknown): SkillRegistryDiagnostic {
  if (isFileSystemError(error, 'ENOENT')) {
    return { candidate, code: 'skill_file_missing', message: 'Skill directory does not contain SKILL.md.' }
  }
  if (error && typeof error === 'object' && 'diagnosticCode' in error && typeof error.diagnosticCode === 'string') {
    return {
      candidate,
      code: error.diagnosticCode as SkillRegistryDiagnostic['code'],
      message: error instanceof Error ? error.message : 'Skill metadata is invalid.',
    }
  }
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'skill_file_too_large') {
      return { candidate, code: 'skill_file_too_large', message: error instanceof Error ? error.message : 'Skill file is too large.' }
    }
    if (error.code === 'skill_file_unsafe' || error.code === 'unsafe_path') {
      return { candidate, code: 'skill_file_unsafe', message: error instanceof Error ? error.message : 'Skill file is unsafe.' }
    }
  }
  return {
    candidate,
    code: 'frontmatter_invalid',
    message: error instanceof Error ? error.message : 'Skill metadata could not be read.',
  }
}

function diagnosticError(code: SkillRegistryDiagnostic['code'], message: string) {
  return Object.assign(new Error(message), { diagnosticCode: code })
}
