import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  HarnessSkillError,
  type EnqueueSequentialHarnessMissionInput,
  type HarnessFinalOutputContract,
  type HarnessMissionView,
  type JsonValue,
  type OpenSequentialHarnessMissionQueueInput,
  type SequentialHarnessMissionQueue,
} from '../contracts.js'
import { canonicalJson, sha256 } from '../internal/filesystem.js'
import { assertValidJsonSchema } from '../internal/json-schema.js'
import { MissionQueueStore } from '../internal/mission-store.js'

const MAX_TASK_PROMPT_BYTES = 64 * 1024

type FrozenMissionSpec = {
  protocol: 'tokenless.web-agent.mission-admission/v1'
  provider: string
  profileId: string
  taskPrompt: string
  finalOutput: HarnessFinalOutputContract
  runLimits: { maxTurns: number; cooldownMs: number }
}

class SequentialMissionQueue implements SequentialHarnessMissionQueue {
  constructor(private readonly store: MissionQueueStore) {}

  enqueue(input: EnqueueSequentialHarnessMissionInput): HarnessMissionView {
    const spec = freezeSpec(input)
    return this.store.enqueue({
      taskRef: opaqueRef('task'),
      runId: opaqueRef('run'),
      nonce: opaqueRef('nonce'),
      requestRef: opaqueRef('request'),
      promptSha256: sha256(spec.taskPrompt),
      specJson: canonicalJson(spec as unknown as JsonValue),
    })
  }

  read(taskRef: string) {
    return this.store.read(taskRef)
  }

  list() {
    return this.store.list()
  }

  activateNext() {
    return this.store.activateNext()
  }

  cancel(taskRef: string) {
    return this.store.cancel(taskRef)
  }

  close() {
    this.store.close()
  }
}

/** Opens the private, durable admission ledger. It does not contact a provider or daemon. */
export async function openSequentialHarnessMissionQueue(
  input: OpenSequentialHarnessMissionQueueInput,
): Promise<SequentialHarnessMissionQueue> {
  await ensureStagingRoot(input.stagingRoot)
  return new SequentialMissionQueue(await MissionQueueStore.open(input.tokenlessHome))
}

function freezeSpec(input: EnqueueSequentialHarnessMissionInput): FrozenMissionSpec {
  if (!isRecord(input) || Object.keys(input).some((key) => ![
    'provider', 'profileId', 'taskPrompt', 'finalOutput', 'maxTurns', 'cooldownMs',
  ].includes(key))) {
    throw new HarnessSkillError('mission_spec_invalid', 'Sequential Harness mission input is invalid.')
  }
  const provider = text(input.provider, /^[a-z][a-z0-9-]{0,63}$/, 'provider')
  const profileId = text(input.profileId, /^[A-Za-z0-9_-]{1,128}$/, 'profileId')
  const taskPrompt = text(input.taskPrompt, undefined, 'taskPrompt')
  if (Buffer.byteLength(taskPrompt, 'utf8') > MAX_TASK_PROMPT_BYTES) {
    throw new HarnessSkillError('mission_spec_invalid', 'taskPrompt exceeds the sequential mission admission limit.')
  }
  return {
    protocol: 'tokenless.web-agent.mission-admission/v1',
    provider,
    profileId,
    taskPrompt,
    finalOutput: finalOutput(input.finalOutput),
    runLimits: {
      maxTurns: boundedInteger(input.maxTurns, 1, 64, 1, 'maxTurns'),
      cooldownMs: boundedInteger(input.cooldownMs, 0, 86_400_000, 0, 'cooldownMs'),
    },
  }
}

function finalOutput(value: HarnessFinalOutputContract | undefined): HarnessFinalOutputContract {
  if (value === undefined) return { kind: 'markdown' }
  if (!isRecord(value)) throw new HarnessSkillError('mission_spec_invalid', 'finalOutput is invalid.')
  if (value.kind === 'markdown' && Object.keys(value).length === 1) return { kind: 'markdown' }
  if (value.kind !== 'json_schema' || Object.keys(value).length !== 2) {
    throw new HarnessSkillError('mission_spec_invalid', 'finalOutput is invalid.')
  }
  const schema = jsonValue(value.schema)
  if (Buffer.byteLength(canonicalJson(schema), 'utf8') > 256 * 1024) {
    throw new HarnessSkillError('mission_spec_invalid', 'finalOutput schema exceeds the sequential mission admission limit.')
  }
  assertValidJsonSchema(schema, 'finalOutput.schema')
  return { kind: 'json_schema', schema }
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new HarnessSkillError('mission_spec_invalid', 'finalOutput schema is too deeply nested.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > 256) throw new HarnessSkillError('mission_spec_invalid', 'finalOutput schema has too many values.')
    return value.map((entry) => jsonValue(entry, depth + 1))
  }
  if (!isRecord(value) || Object.keys(value).length > 256) {
    throw new HarnessSkillError('mission_spec_invalid', 'finalOutput schema must be JSON data.')
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonValue(value[key], depth + 1)]))
}

async function ensureStagingRoot(value: string) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new HarnessSkillError('mission_staging_root_invalid', 'stagingRoot must be a nonempty path without NUL bytes.')
  }
  const requested = path.resolve(value)
  await fs.mkdir(requested, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(requested)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new HarnessSkillError('mission_staging_root_invalid', 'stagingRoot must be a regular directory.')
  }
}

function opaqueRef(kind: 'task' | 'run' | 'nonce' | 'request') {
  return `${kind}:${randomBytes(16).toString('hex')}`
}

function text(value: unknown, pattern: RegExp | undefined, label: string) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || (pattern && !pattern.test(value))) {
    throw new HarnessSkillError('mission_spec_invalid', `${label} is invalid.`)
  }
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HarnessSkillError('mission_spec_invalid', `${label} is invalid.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}
