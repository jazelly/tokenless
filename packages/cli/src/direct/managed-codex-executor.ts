import fs from 'node:fs/promises'
import path from 'node:path'

import {
  AccountPoolStore,
  accountPoolAccountLockPath,
  type AccountUnavailableReason,
  type CodexAccountRecord,
  type ProjectBinding,
} from './account-pool.js'
import { createSqliteAccountPoolSerialization } from './account-pool-lock.js'
import { chatGptInferenceLockPath } from './codex-account-admin.js'
import {
  CodexChildSupervisorError,
  codexInferenceOperationTimeoutMs,
  runCodexSupervisedOperation,
} from './codex-child-supervisor.js'
import { resolveTrustedCodexExecutable } from './codex-profile.js'
import type { ManagedResponsesRequest } from './managed-responses.js'
import { resolveSqliteLockTimeout } from './sqlite-lock.js'

const DEFAULT_ACCOUNT_READ_TIMEOUT_MS = 15_000
const MAX_ACCOUNT_READ_TIMEOUT_MS = 120_000
const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000
const MAX_INFERENCE_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export type ManagedCodexProjectExecution = Readonly<{
  homeDir: string
  projectId: string
  initialBinding: ProjectBinding
  initialAccount: CodexAccountRecord
  request: ManagedResponsesRequest
  signal: AbortSignal
}>

export type ManagedCodexProjectExecutor = (
  execution: ManagedCodexProjectExecution,
) => Promise<string>

export type ManagedCodexExecutorOptions = Readonly<{
  codexExecutable?: string | undefined
  lockTimeoutMs?: number | undefined
  accountReadTimeoutMs?: number | undefined
  inferenceTimeoutMs?: number | undefined
  environment?: NodeJS.ProcessEnv | undefined
}>

export type ManagedCodexExecutorFailureCode =
  | 'managed_executor_aborted'
  | 'managed_executor_failed'
  | 'managed_executor_timeout'
  | 'managed_executor_unavailable'

export class ManagedCodexExecutorFailure extends Error {
  readonly code: ManagedCodexExecutorFailureCode
  readonly retryable: boolean
  readonly deliveryUnknown: boolean

  constructor(
    code: ManagedCodexExecutorFailureCode,
    message: string,
    options: Readonly<{ retryable: boolean; deliveryUnknown: boolean }>,
  ) {
    super(message)
    this.name = 'ManagedCodexExecutorFailure'
    this.code = code
    this.retryable = options.retryable
    this.deliveryUnknown = options.deliveryUnknown
  }
}

/** Creates the production executor consumed by the managed project router. */
export function createManagedCodexProjectExecutor(
  options: ManagedCodexExecutorOptions = {},
): ManagedCodexProjectExecutor {
  const lockTimeoutMs = resolveSqliteLockTimeout(options.lockTimeoutMs)
  const accountReadTimeoutMs = boundedTimeout(
    options.accountReadTimeoutMs,
    DEFAULT_ACCOUNT_READ_TIMEOUT_MS,
    MAX_ACCOUNT_READ_TIMEOUT_MS,
    'account read timeout',
  )
  const inferenceTimeoutMs = boundedTimeout(
    options.inferenceTimeoutMs ?? environmentTimeout(options.environment ?? process.env),
    DEFAULT_INFERENCE_TIMEOUT_MS,
    MAX_INFERENCE_TIMEOUT_MS,
    'inference timeout',
  )
  const environment = Object.freeze({ ...(options.environment ?? process.env) })

  return async (execution) => {
    let homeDir: string | undefined
    try {
      validateExecution(execution)
      homeDir = await canonicalHome(execution.homeDir)
      const codexExecutable = await resolveTrustedCodexExecutable(options.codexExecutable)
      const result = await runCodexSupervisedOperation<unknown>({
        operation: 'infer-managed',
        homeDir,
        codexExecutable,
        lockFiles: [
          accountPoolAccountLockPath(homeDir, 'chatgpt', execution.initialAccount.internalId),
          chatGptInferenceLockPath(homeDir),
        ],
        lockTimeoutMs,
        operationTimeoutMs: codexInferenceOperationTimeoutMs(accountReadTimeoutMs, inferenceTimeoutMs),
        accountReadTimeoutMs,
        inferenceTimeoutMs,
        accountId: execution.initialAccount.accountId,
        expectedInternalId: execution.initialAccount.internalId,
        expectedBindingGeneration: execution.initialBinding.generation,
        expectedIdentityFingerprint: execution.initialAccount.identityFingerprint!,
        projectId: execution.projectId,
        prompt: execution.request.input,
        ...(execution.request.model === undefined ? {} : { model: execution.request.model }),
        environment,
        signal: execution.signal,
      })
      return decodeResult(result)
    } catch (error) {
      if (homeDir !== undefined) {
        await persistProvenUnavailability(error, execution, homeDir, lockTimeoutMs)
      }
      throw normalizeFailure(error, execution?.signal?.aborted === true)
    }
  }
}

function validateExecution(execution: ManagedCodexProjectExecution): void {
  if (
    execution === null || typeof execution !== 'object' ||
    typeof execution.homeDir !== 'string' || execution.homeDir.trim() === '' || execution.homeDir.includes('\0') ||
    typeof execution.projectId !== 'string' ||
    !(execution.signal instanceof AbortSignal) ||
    execution.initialBinding === null || typeof execution.initialBinding !== 'object' ||
    execution.initialAccount === null || typeof execution.initialAccount !== 'object' ||
    execution.request === null || typeof execution.request !== 'object'
  ) throw unavailableFailure()
  const { initialAccount: account, initialBinding: binding, request } = execution
  if (
    binding.projectId !== execution.projectId || binding.provider !== 'chatgpt' ||
    binding.accountInternalId !== account.internalId ||
    !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
    account.provider !== 'chatgpt' || account.driver !== 'official-codex' ||
    account.status !== 'ready' || !account.enabled ||
    account.health?.state !== 'usable' ||
    !Number.isSafeInteger(account.health.generation) || account.health.generation < 0 ||
    typeof account.identityFingerprint !== 'string' ||
    typeof request.input !== 'string' || !/\S/u.test(request.input) || !isUnicodeScalarText(request.input) ||
    Buffer.byteLength(request.input, 'utf8') > 4 * 1024 * 1024 ||
    (request.stream !== true && request.stream !== false) || request.store !== false ||
    (request.model !== undefined && (
      typeof request.model !== 'string' || request.model.trim() === '' ||
      /[\u0000-\u001f\u007f]/u.test(request.model) || Buffer.byteLength(request.model, 'utf8') > 256
    ))
  ) throw unavailableFailure()
}

async function persistProvenUnavailability(
  error: unknown,
  execution: ManagedCodexProjectExecution,
  homeDir: string,
  lockTimeoutMs: number,
): Promise<void> {
  if (!(error instanceof CodexChildSupervisorError) || error.code !== 'codex_inference_unavailable') return
  if (error.deliveryUnknown) return
  const reason = durableReason(error.reason)
  if (reason === undefined) return
  const store = new AccountPoolStore({
    homeDir,
    serialize: createSqliteAccountPoolSerialization({ homeDir, timeoutMs: lockTimeoutMs }),
  })
  try {
    await store.markUnavailableIfCurrent({
      provider: 'chatgpt',
      accountInternalId: execution.initialAccount.internalId,
      expectedHealthGeneration: execution.initialAccount.health.generation,
      reason,
    })
  } catch {
    throw new ManagedCodexExecutorFailure(
      'managed_executor_failed',
      'The managed ChatGPT account health could not be persisted safely.',
      { retryable: true, deliveryUnknown: false },
    )
  }
}

function durableReason(reason: string | undefined): AccountUnavailableReason | undefined {
  if (reason === 'no_account') return 'codex_no_account'
  if (reason === 'not_chatgpt') return 'codex_not_chatgpt'
  if (reason === 'identity_missing') return 'codex_identity_unverifiable'
  if (reason === 'identity_mismatch') return 'codex_identity_mismatch'
  if (reason === 'profile_invalid') return 'codex_profile_unsafe'
  return undefined
}

async function canonicalHome(value: string): Promise<string> {
  const resolved = path.resolve(value)
  const canonical = await fs.realpath(resolved).catch(() => {
    throw unavailableFailure()
  })
  if (canonical !== resolved) throw unavailableFailure()
  return canonical
}

function decodeResult(value: unknown): string {
  if (!isRecord(value)) throw invalidResponseFailure()
  const allowed = new Set(['model', 'textBase64', 'usage'])
  if (
    !Object.hasOwn(value, 'textBase64') ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.textBase64 !== 'string' || value.textBase64.length > 2_796_208 ||
    (value.model !== undefined && typeof value.model !== 'string') ||
    (value.usage !== undefined && !validUsage(value.usage))
  ) throw invalidResponseFailure()
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.textBase64)) {
    throw invalidResponseFailure()
  }
  const bytes = Buffer.from(value.textBase64, 'base64')
  if (
    bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES ||
    bytes.toString('base64') !== value.textBase64
  ) throw invalidResponseFailure()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidResponseFailure()
  }
  if (text.trim() === '') throw invalidResponseFailure()
  return text
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((key) => !['inputTokens', 'outputTokens', 'totalTokens'].includes(key))) return false
  return Object.values(value).every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
}

function normalizeFailure(error: unknown, signalAborted = false): ManagedCodexExecutorFailure {
  if (error instanceof ManagedCodexExecutorFailure) return error
  if (error instanceof CodexChildSupervisorError) {
    const deliveryUnknown = error.deliveryUnknown
    if (signalAborted) {
      return new ManagedCodexExecutorFailure(
        'managed_executor_aborted',
        'The managed ChatGPT execution was aborted.',
        { retryable: true, deliveryUnknown },
      )
    }
    if (error.code === 'codex_inference_unavailable') return unavailableFailure()
    if (error.code.includes('aborted')) {
      return new ManagedCodexExecutorFailure(
        'managed_executor_aborted',
        'The managed ChatGPT execution was aborted.',
        { retryable: true, deliveryUnknown },
      )
    }
    if (error.code.includes('timeout') || error.reason === 'codex_timeout') {
      return new ManagedCodexExecutorFailure(
        'managed_executor_timeout',
        'The managed ChatGPT execution timed out.',
        { retryable: true, deliveryUnknown },
      )
    }
    return new ManagedCodexExecutorFailure(
      'managed_executor_failed',
      'The managed ChatGPT execution failed.',
      { retryable: error.retryable, deliveryUnknown },
    )
  }
  return new ManagedCodexExecutorFailure(
    'managed_executor_failed',
    'The managed ChatGPT execution failed.',
    { retryable: false, deliveryUnknown: false },
  )
}

function unavailableFailure(): ManagedCodexExecutorFailure {
  return new ManagedCodexExecutorFailure(
    'managed_executor_unavailable',
    'The managed ChatGPT account is unavailable before prompt dispatch.',
    { retryable: false, deliveryUnknown: false },
  )
}

function invalidResponseFailure(): ManagedCodexExecutorFailure {
  return new ManagedCodexExecutorFailure(
    'managed_executor_failed',
    'The managed ChatGPT execution returned an invalid result.',
    { retryable: false, deliveryUnknown: true },
  )
}

function environmentTimeout(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.TOKENLESS_DIRECT_TIMEOUT_MS
  return value === undefined ? undefined : Number(value)
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new TypeError(`Managed Codex ${name} must be an integer between 1 and ${maximum}.`)
  }
  return candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}
