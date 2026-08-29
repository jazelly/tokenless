import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  HarnessSkillError,
  type HarnessToolCatalogEntry,
  type HarnessToolExecutionContext,
  type HarnessToolRegistry,
  type JsonValue,
} from '../contracts.js'
import { createStdioMcpToolRegistry } from '../mcp/stdio.js'

const execFileAsync = promisify(execFile)
const WORKSPACE_SERVER = 'tokenless-workspace'
const MAX_READ_BYTES = 1024 * 1024
const MAX_SEARCH_BYTES = 256 * 1024
const MAX_EXEC_COMMAND_CHARS = 32 * 1024
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_EXEC_TIMEOUT_MS = 120_000
const EXEC_TERMINATION_GRACE_MS = 1_000
const WORKSPACE_EXEC_BLOCKED_ENV = new Set([
  'TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL',
  'TOKENLESS_BENCHMARK_CHANNEL_TOKEN',
])
type WorkspaceExecPurpose = 'inspect' | 'implement' | 'verify'
const WORKSPACE_EXEC_PURPOSES = new Set<WorkspaceExecPurpose>(['inspect', 'implement', 'verify'])

export type WorkspaceExecObservation = {
  callIdSha256: string | null
  purpose: WorkspaceExecPurpose | null
  commandCharacters: number
  commandSha256: string
  timeoutMs: number
  outcome: 'succeeded' | 'failed'
  exitCode: number | null
  signal: string | null
  timedOut: boolean | null
}

const WORKSPACE_TOOLS: readonly HarnessToolCatalogEntry[] = [
  {
    name: 'workspace.read',
    description: 'Read a bounded range of UTF-8 text lines from a file inside the delegated workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to an existing file inside the delegated workspace; never use an absolute path.', minLength: 1, maxLength: 4096 },
        startLine: { type: 'integer', minimum: 1 },
        lineCount: { type: 'integer', minimum: 1, maximum: 400 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    source: 'filesystem',
    server: WORKSPACE_SERVER,
    serverToolName: 'read',
    readOnly: true,
    approval: 'allow_read_only',
  },
  {
    name: 'workspace.search',
    description: 'Search UTF-8 workspace files with ripgrep and return bounded line matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1024 },
        path: { type: 'string', description: 'Relative path to an existing file or directory inside the delegated workspace; use . when unsure and never use an absolute path.', minLength: 1, maxLength: 4096 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    source: 'filesystem',
    server: WORKSPACE_SERVER,
    serverToolName: 'search',
    readOnly: true,
    approval: 'allow_read_only',
  },
]

export function createAgentToolRegistry(options: {
  enableWorkspaceExec?: boolean
  requireWorkspaceExecPurpose?: boolean
  onWorkspaceExec?: ((summary: WorkspaceExecObservation) => void | Promise<void>) | undefined
} = {}): HarnessToolRegistry {
  const mcp = createStdioMcpToolRegistry()
  const activeCommands = new Set<WorkspaceCommandRun>()
  return {
    async catalog(servers, context) {
      const workspaceRoot = context?.workspaceRoot
      const workspace = workspaceRoot === undefined
        ? []
        : (await canonicalWorkspaceRoot(workspaceRoot), [
          ...WORKSPACE_TOOLS,
          ...(options.enableWorkspaceExec ? [workspaceExecTool(options.requireWorkspaceExecPurpose === true)] : []),
        ])
      const catalog = [...workspace, ...await mcp.catalog(servers, context)]
      const names = new Set<string>()
      for (const entry of catalog) {
        if (names.has(entry.name)) throw new HarnessSkillError('harness_tool_duplicate', `Harness tool '${entry.name}' is duplicated.`)
        names.add(entry.name)
      }
      return catalog.toSorted((left, right) => left.name.localeCompare(right.name))
    },

    async execute(entry, argumentsValue, servers, context) {
      if (entry.server !== WORKSPACE_SERVER) return mcp.execute(entry, argumentsValue, servers, context)
      const workspaceRoot = context?.workspaceRoot
      if (workspaceRoot === undefined) throw new HarnessSkillError('harness_workspace_missing', 'The delegated run has no workspace root.')
      const root = await canonicalWorkspaceRoot(workspaceRoot)
      if (entry.serverToolName === 'read') return { status: 'succeeded', content: await readWorkspaceFile(root, argumentsValue) }
      if (entry.serverToolName === 'search') return { status: 'succeeded', content: await searchWorkspace(root, argumentsValue) }
      if (entry.serverToolName === 'exec' && options.enableWorkspaceExec) {
        return executeWorkspaceCommand(
          root,
          argumentsValue,
          activeCommands,
          context,
          options.requireWorkspaceExecPurpose === true,
          options.onWorkspaceExec,
        )
      }
      throw new HarnessSkillError('harness_tool_not_configured', `Workspace tool '${entry.name}' is not configured.`)
    },
    async close() {
      const commands = [...activeCommands]
      await Promise.all(commands.map((command) => command.terminate()))
      await Promise.all(commands.map((command) => command.result.catch(() => undefined)))
    },
  }
}

function executeWorkspaceCommand(
  root: string,
  input: Record<string, JsonValue>,
  activeCommands: Set<WorkspaceCommandRun>,
  context: HarnessToolExecutionContext | undefined,
  requirePurpose: boolean,
  observer: ((summary: WorkspaceExecObservation) => void | Promise<void>) | undefined,
): Promise<{
  status: 'succeeded' | 'failed'
  content: JsonValue
}> {
  const command = input.command
  if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_EXEC_COMMAND_CHARS) {
    throw new HarnessSkillError('harness_workspace_exec_invalid', `Workspace command must be nonempty and no longer than ${MAX_EXEC_COMMAND_CHARS} characters.`)
  }
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_EXEC_TIMEOUT_MS : input.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1_000 || Number(timeoutMs) > MAX_EXEC_TIMEOUT_MS) {
    throw new HarnessSkillError('harness_workspace_exec_invalid', `Workspace command timeoutMs must be 1000-${MAX_EXEC_TIMEOUT_MS}.`)
  }
  const purpose = typeof input.purpose === 'string' && WORKSPACE_EXEC_PURPOSES.has(input.purpose as WorkspaceExecPurpose)
    ? input.purpose as WorkspaceExecPurpose
    : null
  if (requirePurpose && purpose === null) {
    throw new HarnessSkillError('harness_workspace_exec_invalid', 'Workspace command purpose must be inspect, implement, or verify.')
  }
  const commandRun = runWorkspaceCommand(root, command, Number(timeoutMs))
  activeCommands.add(commandRun)
  return commandRun.result
    .then(async (execution) => {
      await observer?.(workspaceExecObservation(command, purpose, Number(timeoutMs), context?.callId, execution))
      return execution
    })
    .finally(() => activeCommands.delete(commandRun))
}

type CapturedCommandOutput = {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

type WorkspaceCommandRun = {
  result: Promise<{
    status: 'succeeded' | 'failed'
    content: JsonValue
  }>
  terminate: () => Promise<void>
}

function runWorkspaceCommand(root: string, command: string, timeoutMs: number): WorkspaceCommandRun {
  let stop: () => Promise<void> = async () => undefined
  const result = new Promise<{
    status: 'succeeded' | 'failed'
    content: JsonValue
  }>((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: root,
      env: sanitizedWorkspaceExecEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: CapturedCommandOutput = { chunks: [], bytes: 0, truncated: false }
    const stderr: CapturedCommandOutput = { chunks: [], bytes: 0, truncated: false }
    let timedOut = false
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let termination: Promise<void> | undefined
    let closeResolve: (() => void) | undefined
    const closed = new Promise<void>((resolve) => { closeResolve = resolve })
    const terminate = () => {
      termination ??= terminateWorkspaceProcessTree(child)
      return termination
    }
    stop = () => terminate()
    child.stdout?.on('data', (chunk: Buffer | string) => captureCommandOutput(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => captureCommandOutput(stderr, chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      void settle(null, null, typeof error.code === 'string' ? error.code : undefined)
    })
    child.once('exit', (exitCode, signal) => {
      void settle(exitCode, signal)
    })
    child.once('close', () => { closeResolve?.() })
    timeoutHandle = setTimeout(() => {
      timedOut = true
      void terminate()
    }, timeoutMs)

    async function settle(exitCode: number | null, signal: NodeJS.Signals | null, errorCode?: string) {
      if (settled) return
      settled = true
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      await terminate()
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, EXEC_TERMINATION_GRACE_MS)),
      ])
      resolve({
        status: !timedOut && errorCode === undefined && exitCode === 0 && signal === null ? 'succeeded' : 'failed',
        content: foregroundCommandResult(stdout, stderr, exitCode, signal, timedOut, timeoutMs, errorCode),
      })
    }
  })
  return { result, terminate: () => stop() }
}

function foregroundCommandResult(
  stdout: CapturedCommandOutput,
  stderr: CapturedCommandOutput,
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  timeoutMs: number,
  errorCode?: string,
): JsonValue {
  return {
    kind: 'foreground',
    exitCode,
    signal,
    timedOut,
    timeoutMs,
    stdout: capturedCommandText(stdout),
    stderr: capturedCommandText(stderr),
    outputTruncated: stdout.truncated || stderr.truncated,
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

function workspaceExecObservation(
  command: string,
  purpose: WorkspaceExecPurpose | null,
  timeoutMs: number,
  callId: string | undefined,
  execution: { status: 'succeeded' | 'failed'; content: JsonValue },
): WorkspaceExecObservation {
  const value = execution.content
  const foreground = value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.kind === 'foreground'
  return {
    callIdSha256: typeof callId === 'string' ? sha256(callId) : null,
    purpose,
    commandCharacters: command.length,
    commandSha256: sha256(command),
    timeoutMs,
    outcome: execution.status,
    exitCode: foreground && (typeof value.exitCode === 'number' || value.exitCode === null)
      ? value.exitCode
      : null,
    signal: foreground && (typeof value.signal === 'string' || value.signal === null)
      ? value.signal
      : null,
    timedOut: foreground && typeof value.timedOut === 'boolean' ? value.timedOut : null,
  }
}

function workspaceExecTool(requirePurpose: boolean): HarnessToolCatalogEntry {
  return {
    name: 'workspace.exec',
    description: requirePurpose
      ? 'Run one bounded foreground bash command with the delegated workspace as its working directory. Include purpose as inspect, implement, or verify. A verify command must assert all publicly stated observable outcomes, wait for asynchronous outputs, and fail on missing or invalid artifacts; invocation, exit 0, syntax/load, existence, version, or weak smoke alone is not verification.'
      : 'Run one bounded foreground bash command with the delegated workspace as its working directory. Use this to create files, run checks, and inspect the bounded result before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: MAX_EXEC_COMMAND_CHARS },
        timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_EXEC_TIMEOUT_MS },
        ...(requirePurpose ? { purpose: { type: 'string', enum: ['inspect', 'implement', 'verify'] } } : {}),
      },
      required: requirePurpose ? ['command', 'purpose'] : ['command'],
      additionalProperties: false,
    },
    source: 'local',
    server: WORKSPACE_SERVER,
    serverToolName: 'exec',
    readOnly: false,
    approval: 'allow_trusted',
  }
}

function sha256(value: string) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function captureCommandOutput(capture: CapturedCommandOutput, value: Buffer | string) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const remaining = MAX_EXEC_OUTPUT_BYTES - capture.bytes
  if (remaining > 0) {
    capture.chunks.push(bytes.subarray(0, remaining))
    capture.bytes += Math.min(bytes.byteLength, remaining)
  }
  if (bytes.byteLength > remaining) capture.truncated = true
}

function capturedCommandText(capture: CapturedCommandOutput) {
  return Buffer.concat(capture.chunks).toString('utf8')
}

function sanitizedWorkspaceExecEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !WORKSPACE_EXEC_BLOCKED_ENV.has(key)),
  )
}

async function terminateWorkspaceProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || pid <= 0) return
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    return
  }
  signalWorkspaceProcessGroup(pid, 'SIGTERM')
  if (await waitForWorkspaceProcessGroupExit(pid, EXEC_TERMINATION_GRACE_MS)) return
  signalWorkspaceProcessGroup(pid, 'SIGKILL')
  await waitForWorkspaceProcessGroupExit(pid, EXEC_TERMINATION_GRACE_MS)
}

function signalWorkspaceProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
  }
}

async function waitForWorkspaceProcessGroupExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (workspaceProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  return true
}

function workspaceProcessGroupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function canonicalWorkspaceRoot(value: string) {
  const requested = path.resolve(value)
  const stat = await fs.lstat(requested).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new HarnessSkillError('harness_workspace_invalid', 'The delegated workspace root must be an existing regular directory.')
  }
  return fs.realpath(requested)
}

async function workspaceTarget(root: string, value: unknown, defaultPath?: string) {
  const relative = value === undefined ? defaultPath : value
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool paths must be nonempty relative paths.')
  }
  const requested = path.resolve(root, relative)
  if (!isWithin(root, requested)) throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool path escapes the delegated root.')
  const canonical = await fs.realpath(requested).catch(() => null)
  if (!canonical || !isWithin(root, canonical)) {
    throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool path is missing or resolves outside the delegated root.')
  }
  return { requested, relative: path.relative(root, canonical) || '.', canonical }
}

async function readWorkspaceFile(root: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const target = await workspaceTarget(root, input.path)
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(target.canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file could not be opened safely.')
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
      throw new HarnessSkillError('harness_workspace_read_invalid', `Workspace file must be a regular UTF-8 file no larger than ${MAX_READ_BYTES} bytes.`)
    }
    await verifyOpenedWorkspaceFile(root, target.requested, handle)
    const bytes = await handle.readFile()
    await verifyOpenedWorkspaceFile(root, target.requested, handle)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file is not UTF-8 text.')
    }
    const lines = text.split(/\r?\n/u)
    const startLine = optionalPositiveInteger(input.startLine, 1, 'startLine')
    const lineCount = optionalPositiveInteger(input.lineCount, 200, 'lineCount')
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount)
    return {
      path: target.relative,
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
      text: selected.join('\n'),
    }
  } finally {
    await handle.close()
  }
}

async function searchWorkspace(root: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const query = input.query
  if (typeof query !== 'string' || query.length === 0) throw new HarnessSkillError('harness_workspace_search_invalid', 'Workspace search query is required.')
  const target = await workspaceTarget(root, input.path, '.')
  const identity = await fs.stat(target.canonical, { bigint: true })
  if (!identity.isFile() && !identity.isDirectory()) {
    throw new HarnessSkillError('harness_workspace_search_invalid', 'Workspace search path must be a regular file or directory.')
  }
  await verifyWorkspacePathIdentity(root, target.requested, identity)
  try {
    const { stdout } = await execFileAsync('rg', [
      '--line-number', '--no-heading', '--color', 'never', '--glob', '!.git', '--', query, target.relative,
    ], { cwd: root, encoding: 'utf8', maxBuffer: MAX_SEARCH_BYTES, timeout: 30_000 })
    await verifyWorkspacePathIdentity(root, target.requested, identity)
    return { path: target.relative, query, matches: stdout.trimEnd() }
  } catch (error) {
    const failure = error as { code?: string | number }
    if (Number(failure.code) === 1) {
      await verifyWorkspacePathIdentity(root, target.requested, identity)
      return { path: target.relative, query, matches: '' }
    }
    if (error instanceof HarnessSkillError) throw error
    throw new HarnessSkillError('harness_workspace_search_failed', 'Workspace search failed at the local ripgrep boundary.')
  }
}

async function verifyOpenedWorkspaceFile(
  root: string,
  requested: string,
  handle: Awaited<ReturnType<typeof fs.open>>,
) {
  const opened = await handle.stat({ bigint: true })
  if (!opened.isFile()) throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file must remain a regular file.')
  await verifyWorkspacePathIdentity(root, requested, opened)
}

async function verifyWorkspacePathIdentity(
  root: string,
  requested: string,
  expected: { dev: bigint; ino: bigint },
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const firstPath = await fs.realpath(requested).catch(() => null)
    if (!firstPath || !isWithin(root, firstPath)) break
    const first = await fs.stat(firstPath, { bigint: true }).catch(() => null)
    const secondPath = await fs.realpath(requested).catch(() => null)
    if (!secondPath || !isWithin(root, secondPath)) break
    const second = await fs.stat(secondPath, { bigint: true }).catch(() => null)
    if (firstPath === secondPath && first && second && sameFile(expected, first) && sameFile(expected, second)) return
  }
  throw new HarnessSkillError('harness_workspace_path_changed', 'Workspace path changed while root containment was being enforced.')
}

function sameFile(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }) {
  return left.dev === right.dev && left.ino === right.ino
}

function optionalPositiveInteger(value: JsonValue | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new HarnessSkillError('harness_workspace_arguments_invalid', `${label} must be a positive integer.`)
  }
  return Number(value)
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
