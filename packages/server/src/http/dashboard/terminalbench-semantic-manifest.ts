import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  DashboardTerminalBenchSemanticManifestEntry,
  DashboardTerminalBenchSemanticManifestResult,
  DashboardTerminalBenchSemanticTasks,
} from 'tokenless-internal-shared/dashboard'

const SCHEMA = 'tokenless.terminalbench-semantic-manifest.v1' as const
const TASKS_SCHEMA = 'tokenless.terminalbench-semantic-manifest-tasks.v1' as const
const DATASET = 'terminal-bench/terminal-bench-2'
const TASK_COUNT = 89
const DATASET_REF = 'sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b'
const INSTRUCTION_DIGEST = 'sha256:5b6a2e01c29b8f215daa2e430f75d2a12c3c4ffc627d8cf4ebc1b38cd0d353ea'
const TASK_REF_DIGEST = 'sha256:82cddb9ea94d792455d3e32b3c8a60ed73003714ed01785ec3b1ec5c580bccba'
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const COMPLEXITIES = new Set(['low', 'medium', 'high'])
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u

type OfficialManifest = {
  schema?: unknown
  dataset?: unknown
  datasetRef?: unknown
  instructionDigest?: unknown
  taskRefDigest?: unknown
  taskCount?: unknown
  tasks?: unknown
  taskRefs?: unknown
}

export class TerminalBenchSemanticManifestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 400, code = 'terminalbench_semantic_manifest_invalid') {
    super(message)
    this.name = 'TerminalBenchSemanticManifestError'
    this.status = status
    this.code = code
  }
}

export async function readTerminalBenchSemanticTasks(): Promise<DashboardTerminalBenchSemanticTasks> {
  const manifest = await readOfficialManifest()
  const packageRoot = await resolveTaskPackagesRoot()
  const tasks = []
  const taskNames = Object.keys(manifest.tasks).sort()
  for (const taskName of taskNames) {
    const instructionDigest = manifest.tasks[taskName]
    const taskRef = manifest.taskRefs[taskName]
    if (!instructionDigest || !taskRef) {
      throw new TerminalBenchSemanticManifestError(
        `Pinned Terminal-Bench task metadata is missing for ${taskName}.`,
        503,
        'terminalbench_tasks_unavailable',
      )
    }
    const instructionPath = path.join(
      packageRoot,
      taskName,
      taskRef.slice('sha256:'.length),
      'instruction.md',
    )
    let instruction: string
    try {
      instruction = await fs.readFile(instructionPath, 'utf8')
    } catch {
      throw new TerminalBenchSemanticManifestError(
        `Pinned Terminal-Bench instruction is missing for ${taskName}.`,
        503,
        'terminalbench_tasks_unavailable',
      )
    }
    const observedDigest = `sha256:${createHash('sha256').update(instruction).digest('hex')}`
    if (observedDigest !== instructionDigest) {
      throw new TerminalBenchSemanticManifestError(
        `Pinned Terminal-Bench instruction digest does not match for ${taskName}.`,
        503,
        'terminalbench_tasks_unavailable',
      )
    }
    tasks.push({ instructionDigest, instruction })
  }
  tasks.sort((left, right) => left.instructionDigest.localeCompare(right.instructionDigest))
  return {
    schema: TASKS_SCHEMA,
    dataset: DATASET,
    datasetRef: manifest.datasetRef,
    officialInstructionDigest: manifest.instructionDigest,
    tasks,
  }
}

export async function saveTerminalBenchSemanticManifest(
  outputPath: string,
  entries: DashboardTerminalBenchSemanticManifestEntry[],
): Promise<DashboardTerminalBenchSemanticManifestResult> {
  const tasks = await readTerminalBenchSemanticTasks()
  validateEntries(entries, tasks.tasks)
  const canonical = {
    schema: SCHEMA,
    dataset: tasks.dataset,
    datasetRef: tasks.datasetRef,
    officialInstructionDigest: tasks.officialInstructionDigest,
    entries,
  }
  const manifestDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
  const manifest = { ...canonical, manifestDigest }
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
  )
  let temporaryExists = false
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    temporaryExists = true
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.link(temporaryPath, outputPath)
    await fs.unlink(temporaryPath)
    temporaryExists = false
  } catch (error) {
    if (temporaryExists) await fs.unlink(temporaryPath).catch(() => undefined)
    const code = error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
      ? 'terminalbench_manifest_target_exists'
      : 'terminalbench_manifest_write_failed'
    throw new TerminalBenchSemanticManifestError(
      code === 'terminalbench_manifest_target_exists'
        ? 'The semantic manifest output target already exists.'
        : 'Semantic manifest output could not be written.',
      code === 'terminalbench_manifest_target_exists' ? 409 : 500,
      code,
    )
  }
  return { fileName: path.basename(outputPath), manifestDigest, taskCount: entries.length }
}

async function readOfficialManifest() {
  const candidates = [
    path.resolve(process.cwd(), 'benchmarks/terminalbench/terminal-bench-2-manifest.json'),
    fileURLToPath(new URL('../../../../../../benchmarks/terminalbench/terminal-bench-2-manifest.json', import.meta.url)),
    fileURLToPath(new URL('../../../../../benchmarks/terminalbench/terminal-bench-2-manifest.json', import.meta.url)),
  ]
  let raw: string | undefined
  for (const candidate of candidates) {
    try {
      raw = await fs.readFile(candidate, 'utf8')
      break
    } catch {
      // Try the next source-tree/package location.
    }
  }
  if (raw === undefined) {
    throw new TerminalBenchSemanticManifestError(
      'Pinned Terminal-Bench task manifest is unavailable.',
      503,
      'terminalbench_tasks_unavailable',
    )
  }
  let value: OfficialManifest
  try {
    value = JSON.parse(raw) as OfficialManifest
  } catch {
    throw new TerminalBenchSemanticManifestError(
      'Pinned Terminal-Bench task manifest is invalid.',
      503,
      'terminalbench_tasks_unavailable',
    )
  }
  if (
    value.schema !== 'tokenless.terminalbench-task-manifest.v1'
    || value.dataset !== DATASET
    || value.datasetRef !== DATASET_REF
    || value.instructionDigest !== INSTRUCTION_DIGEST
    || value.taskRefDigest !== TASK_REF_DIGEST
    || value.taskCount !== TASK_COUNT
    || !isStringMap(value.tasks)
    || !isStringMap(value.taskRefs)
  ) {
    throw new TerminalBenchSemanticManifestError(
      'Pinned Terminal-Bench task manifest does not match the expected dataset.',
      503,
      'terminalbench_tasks_unavailable',
    )
  }
  const taskMap = value.tasks
  const taskRefMap = value.taskRefs
  const taskNames = Object.keys(value.tasks).sort()
  if (
    taskNames.length !== TASK_COUNT
    || taskNames.some((name) => taskMap[name] === undefined || taskRefMap[name] === undefined)
    || taskNames.some((name) => !/^[-a-z0-9]+$/u.test(name))
    || taskNames.some((name) => !DIGEST_PATTERN.test(taskMap[name] ?? '') || !DIGEST_PATTERN.test(taskRefMap[name] ?? ''))
    || `sha256:${createHash('sha256').update(JSON.stringify(sortMap(taskMap))).digest('hex')}` !== value.instructionDigest
    || `sha256:${createHash('sha256').update(JSON.stringify(sortMap(taskRefMap))).digest('hex')}` !== value.taskRefDigest
  ) {
    throw new TerminalBenchSemanticManifestError(
      'Pinned Terminal-Bench task manifest is incomplete or has invalid digests.',
      503,
      'terminalbench_tasks_unavailable',
    )
  }
  return {
    datasetRef: value.datasetRef,
    instructionDigest: value.instructionDigest,
    tasks: sortMap(taskMap),
    taskRefs: sortMap(taskRefMap),
  }
}

async function resolveTaskPackagesRoot() {
  const candidates = [
    path.join(os.homedir(), '.cache', 'harbor', 'tasks', 'packages', 'terminal-bench'),
    path.resolve(process.cwd(), '.cache/harbor/tasks/packages/terminal-bench'),
  ]
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // Try the next local cache location.
    }
  }
  throw new TerminalBenchSemanticManifestError(
    'Harbor Terminal-Bench task packages are unavailable.',
    503,
    'terminalbench_tasks_unavailable',
  )
}

function validateEntries(
  entries: DashboardTerminalBenchSemanticManifestEntry[],
  tasks: DashboardTerminalBenchSemanticTasks['tasks'],
) {
  if (!Array.isArray(entries) || entries.length !== TASK_COUNT) {
    throw new TerminalBenchSemanticManifestError(`Semantic manifest must contain exactly ${TASK_COUNT} entries.`)
  }
  const expected = new Map(tasks.map((task) => [task.instructionDigest, task.instruction]))
  const seen = new Set<string>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (
      !entry || typeof entry !== 'object'
      || !sameKeys(entry, ['instructionDigest', 'preferredProvider', 'taskType', 'complexity', 'truncated'])
      || typeof entry.instructionDigest !== 'string'
      || !DIGEST_PATTERN.test(entry.instructionDigest)
      || !expected.has(entry.instructionDigest)
      || seen.has(entry.instructionDigest)
      || typeof entry.preferredProvider !== 'string'
      || !PROVIDER_PATTERN.test(entry.preferredProvider)
      || typeof entry.taskType !== 'string'
      || !TASK_TYPE_PATTERN.test(entry.taskType)
      || !COMPLEXITIES.has(entry.complexity)
      || typeof entry.truncated !== 'boolean'
      || entry.truncated !== ((expected.get(entry.instructionDigest) ?? '').length > 4_000)
    ) {
      throw new TerminalBenchSemanticManifestError('Semantic manifest entry is invalid or not an official instruction digest.')
    }
    if (index > 0 && entries[index - 1]!.instructionDigest >= entry.instructionDigest) {
      throw new TerminalBenchSemanticManifestError('Semantic manifest entries must be sorted by instruction digest.')
    }
    seen.add(entry.instructionDigest)
  }
  if (seen.size !== expected.size) {
    throw new TerminalBenchSemanticManifestError('Semantic manifest must cover every official instruction exactly once.')
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string'))
}

function sortMap(value: Record<string, string>) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function sameKeys(value: object, expected: string[]) {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
