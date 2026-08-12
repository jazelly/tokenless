import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import {
  FEATUREBENCH_AGENT_PROTOCOL,
  FEATUREBENCH_BENCHMARK_COMMIT,
  FEATUREBENCH_DATASET_REVISION,
  FEATUREBENCH_PROTOCOL,
  type FeatureBenchChannelFile,
} from './constants.js'

const execFileAsync = promisify(execFile)
const MAX_PROMPT_BYTES = 900 * 1024
const MAX_ACTIONS_PER_TURN = 8
const MAX_ACTION_TEXT_BYTES = 1024 * 1024
const MAX_CHANNEL_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_OBSERVATION_BYTES = 64 * 1024
const MAX_SEARCH_FILES = 20_000
const MAX_LIST_ENTRIES = 20_000
const DEFAULT_TOOL_TIMEOUT_MS = 120_000

type RuntimeOptions = {
  channelFile: string
  instructionFile: string
  workspace: string
  eventsFile: string
  maxSteps: number
  toolTimeoutMs: number
}

type AgentAction =
  | { tool: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { tool: 'list_files'; path?: string; depth?: number }
  | { tool: 'search'; query: string; path?: string; maxResults?: number }
  | { tool: 'write_file'; path: string; content: string }
  | { tool: 'delete_file'; path: string }
  | { tool: 'apply_patch'; patch: string }
  | ({ tool: 'shell'; timeoutMs?: number } & ProcessInvocation)
  | ({ tool: 'test'; timeoutMs?: number } & ProcessInvocation)

type ProcessInvocation =
  | { argv: string[]; command?: never }
  | { command: string; argv?: never }

type AgentTurn = {
  actions: AgentAction[]
  done: boolean
  summary?: string
}

type ToolObservation = {
  index: number
  tool: AgentAction['tool']
  ok: boolean
  output: string
  truncated: boolean
  durationMs: number
}

export async function runFeatureBenchAgent(options: RuntimeOptions) {
  const workspace = await canonicalDirectory(options.workspace, 'workspace')
  const channel = await consumeChannelFile(options.channelFile)
  const instruction = await fs.readFile(options.instructionFile, 'utf8')
  if (!instruction.trim()) throw runtimeError('featurebench_instruction_empty', 'FeatureBench instruction is empty.')
  const maxSteps = boundedInteger(options.maxSteps, 'maxSteps', 1, Math.min(channel.maxTurns, 200))
  const toolTimeoutMs = boundedInteger(options.toolTimeoutMs, 'toolTimeoutMs', 1_000, 30 * 60_000)
  const writer = new EventWriter(options.eventsFile, channel)
  const transcript: Array<{ role: 'user' | 'assistant'; text: string }> = []
  const initialPrompt = featureBenchSystemPrompt(instruction)
  transcript.push({ role: 'user', text: initialPrompt })
  await writer.write('run.started', {
    workspace,
    maxSteps,
    toolTimeoutMs,
    instructionSha256: sha256(instruction),
  })

  let validationFailures = 0
  let lastObservations: ToolObservation[] = []
  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      const prompt = step === 1
        ? initialPrompt
        : observationPrompt(step, lastObservations, validationFailures)
      if (step > 1) transcript.push({ role: 'user', text: prompt })
      const replayPrompt = renderTranscript(transcript)
      assertPromptSize(replayPrompt)
      await writer.write('provider.turn.started', { step, promptBytes: Buffer.byteLength(prompt), replayPromptBytes: Buffer.byteLength(replayPrompt) })
      const response = await providerTurn(channel, step, prompt, replayPrompt)
      transcript.push({ role: 'assistant', text: response.text })
      await writer.write('provider.turn.completed', {
        step,
        jobId: response.jobId,
        responseSha256: sha256(response.text),
        responseBytes: Buffer.byteLength(response.text),
        citations: response.citations,
      })

      let turn: AgentTurn
      try {
        turn = parseAgentTurn(response.text)
        validationFailures = 0
      } catch (error) {
        validationFailures += 1
        lastObservations = [{
          index: 0,
          tool: 'read_file',
          ok: false,
          output: `action_validation: ${error instanceof Error ? error.message : String(error)}`,
          truncated: false,
          durationMs: 0,
        }]
        await writer.write('action.validation_failed', { step, error: lastObservations[0]!.output })
        continue
      }

      if (turn.done) {
        await writer.write('run.completed', { step, summary: boundedText(turn.summary ?? '', 4_096).text })
        await completeChannel(channel).catch(() => undefined)
        return {
          ok: true,
          protocol: FEATUREBENCH_AGENT_PROTOCOL,
          instanceId: channel.instanceId,
          steps: step,
          summary: turn.summary ?? '',
          eventsFile: options.eventsFile,
        }
      }

      lastObservations = []
      for (let index = 0; index < turn.actions.length; index += 1) {
        const action = turn.actions[index]!
        await writer.write('tool.call', { step, index, action: publicAction(action) })
        const startedAt = Date.now()
        let observation: ToolObservation
        try {
          const output = await executeAction(action, workspace, toolTimeoutMs)
          const bounded = boundedText(redactSecrets(output), MAX_OBSERVATION_BYTES)
          observation = { index, tool: action.tool, ok: true, output: bounded.text, truncated: bounded.truncated, durationMs: Date.now() - startedAt }
        } catch (error) {
          const bounded = boundedText(redactSecrets(error instanceof Error ? error.message : String(error)), MAX_OBSERVATION_BYTES)
          observation = { index, tool: action.tool, ok: false, output: bounded.text, truncated: bounded.truncated, durationMs: Date.now() - startedAt }
        }
        lastObservations.push(observation)
        await writer.write('tool.result', { step, ...observation })
      }
    }
    throw runtimeError('featurebench_step_limit', `FeatureBench agent reached the ${maxSteps}-step limit.`)
  } catch (error) {
    await writer.write('run.failed', {
      category: classifyRuntimeFailure(error),
      code: errorCode(error),
      message: redactSecrets(error instanceof Error ? error.message : String(error)),
    })
    await completeChannel(channel).catch(() => undefined)
    throw error
  }
}

async function consumeChannelFile(channelPath: string): Promise<FeatureBenchChannelFile> {
  let raw: string
  try {
    raw = await fs.readFile(channelPath, 'utf8')
  } finally {
    await fs.rm(channelPath, { force: true }).catch(() => undefined)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw runtimeError('featurebench_channel_invalid', 'FeatureBench channel file is not valid JSON.')
  }
  const channel = plainRecord(value)
  const required = ['channelId', 'token', 'endpoint', 'instanceId', 'provider', 'model', 'executionMode', 'expiresAt']
  if (channel.protocol !== FEATUREBENCH_PROTOCOL || required.some((key) => typeof channel[key] !== 'string')) {
    throw runtimeError('featurebench_channel_invalid', 'FeatureBench channel file has an invalid contract.')
  }
  if (channel.benchmarkCommit !== FEATUREBENCH_BENCHMARK_COMMIT || channel.datasetRevision !== FEATUREBENCH_DATASET_REVISION) {
    throw runtimeError('featurebench_revision_mismatch', 'FeatureBench channel revisions do not match the pinned Tokenless baseline.')
  }
  if (channel.executionMode !== 'browser' && channel.executionMode !== 'direct') {
    throw runtimeError('featurebench_channel_invalid', 'FeatureBench execution mode must be browser or direct.')
  }
  if (!Number.isInteger(channel.maxTurns) || Number(channel.maxTurns) < 1 || Number(channel.maxTurns) > 200) {
    throw runtimeError('featurebench_channel_invalid', 'FeatureBench maxTurns is invalid.')
  }
  if (!Number.isInteger(channel.providerTurnTimeoutMs) || Number(channel.providerTurnTimeoutMs) < 30_000 || Number(channel.providerTurnTimeoutMs) > 30 * 60_000) {
    throw runtimeError('featurebench_channel_invalid', 'FeatureBench providerTurnTimeoutMs is invalid.')
  }
  if (!Number.isFinite(Date.parse(String(channel.expiresAt))) || Date.parse(String(channel.expiresAt)) <= Date.now()) {
    throw runtimeError('featurebench_channel_expired', 'FeatureBench channel has expired.')
  }
  return channel as FeatureBenchChannelFile
}

async function providerTurn(channel: FeatureBenchChannelFile, turn: number, prompt: string, replayPrompt: string) {
  const response = await requestJsonWithTimeout(channel.endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${channel.token}`,
    },
    body: JSON.stringify({ protocol: FEATUREBENCH_PROTOCOL, turn, prompt, replayPrompt }),
  }, Math.min(channel.providerTurnTimeoutMs + 30_000, 31 * 60_000))
  const body = response.body
  if (!response.ok) {
    const error = plainRecord(body.error)
    const failure = runtimeError(
      typeof error.code === 'string' ? error.code : 'featurebench_provider_turn_failed',
      typeof error.message === 'string' ? error.message : `FeatureBench provider turn failed with HTTP ${response.status}.`,
    )
    ;(failure as Error & { category?: string }).category = typeof error.category === 'string' ? error.category : 'provider_turn'
    throw failure
  }
  if (body.protocol !== FEATUREBENCH_PROTOCOL || typeof body.text !== 'string' || typeof body.jobId !== 'string') {
    throw runtimeError('featurebench_channel_response_invalid', 'FeatureBench channel returned an invalid response.')
  }
  return {
    text: body.text,
    jobId: body.jobId,
    citations: Array.isArray(body.citations) ? body.citations : [],
  }
}

async function completeChannel(channel: FeatureBenchChannelFile) {
  await requestJsonWithTimeout(new URL('complete', channel.endpoint.endsWith('/') ? channel.endpoint : `${channel.endpoint}/`).toString(), {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${channel.token}` },
  }, 5_000)
}

function parseAgentTurn(text: string): AgentTurn {
  const candidate = stripCodeFence(text.trim())
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch {
    throw runtimeError('featurebench_action_json_invalid', 'Provider response must be one JSON object with actions and done fields.')
  }
  const record = plainRecord(value)
  const keys = Object.keys(record)
  if (keys.some((key) => !['actions', 'done', 'summary'].includes(key))) {
    throw runtimeError('featurebench_action_unknown_field', 'Provider action envelope contains an unknown field.')
  }
  if (typeof record.done !== 'boolean' || !Array.isArray(record.actions)) {
    throw runtimeError('featurebench_action_invalid', 'Provider action envelope requires boolean done and an actions array.')
  }
  if (record.actions.length > MAX_ACTIONS_PER_TURN) {
    throw runtimeError('featurebench_action_limit', `Provider requested more than ${MAX_ACTIONS_PER_TURN} actions in one turn.`)
  }
  if (record.done && record.actions.length > 0) {
    throw runtimeError('featurebench_action_invalid', 'A done response cannot also request tools.')
  }
  if (!record.done && record.actions.length === 0) {
    throw runtimeError('featurebench_action_invalid', 'A non-final response must request at least one tool action.')
  }
  if (record.summary !== undefined && typeof record.summary !== 'string') {
    throw runtimeError('featurebench_action_invalid', 'Provider action summary must be a string.')
  }
  return {
    done: record.done,
    actions: record.actions.map(validateAction),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  }
}

function validateAction(value: unknown): AgentAction {
  const action = normalizeActionRecord(value)
  if (typeof action.tool !== 'string') throw runtimeError('featurebench_action_invalid', 'Every action requires a tool name.')
  const tool = action.tool
  const exactKeys = (...allowed: string[]) => {
    if (Object.keys(action).some((key) => !['tool', ...allowed].includes(key))) {
      throw runtimeError('featurebench_action_unknown_field', `${tool} action contains an unknown field.`)
    }
  }
  if (tool === 'read_file') {
    exactKeys('path', 'startLine', 'endLine')
    return {
      tool,
      path: requiredActionString(action.path, 'path'),
      ...(action.startLine === undefined ? {} : { startLine: boundedInteger(action.startLine, 'startLine', 1, 10_000_000) }),
      ...(action.endLine === undefined ? {} : { endLine: boundedInteger(action.endLine, 'endLine', 1, 10_000_000) }),
    }
  }
  if (tool === 'list_files') {
    exactKeys('path', 'depth')
    return {
      tool,
      ...(action.path === undefined ? {} : { path: requiredActionString(action.path, 'path') }),
      ...(action.depth === undefined ? {} : { depth: boundedInteger(action.depth, 'depth', 0, 20) }),
    }
  }
  if (tool === 'search') {
    exactKeys('query', 'path', 'maxResults')
    return {
      tool,
      query: requiredActionString(action.query, 'query', 8_192),
      ...(action.path === undefined ? {} : { path: requiredActionString(action.path, 'path') }),
      ...(action.maxResults === undefined ? {} : { maxResults: boundedInteger(action.maxResults, 'maxResults', 1, 1_000) }),
    }
  }
  if (tool === 'write_file') {
    exactKeys('path', 'content')
    return { tool, path: requiredActionString(action.path, 'path'), content: requiredActionString(action.content, 'content', MAX_ACTION_TEXT_BYTES, true) }
  }
  if (tool === 'delete_file') {
    exactKeys('path')
    return { tool, path: requiredActionString(action.path, 'path') }
  }
  if (tool === 'apply_patch') {
    exactKeys('patch')
    return { tool, patch: requiredActionString(action.patch, 'patch', MAX_ACTION_TEXT_BYTES) }
  }
  if (tool === 'shell' || tool === 'test') {
    exactKeys('command', 'argv', 'timeoutMs')
    const hasCommand = action.command !== undefined
    const hasArgv = action.argv !== undefined
    if (hasCommand === hasArgv) {
      throw runtimeError('featurebench_action_invalid', `${tool} action requires exactly one of command or argv.`)
    }
    return {
      tool,
      ...(hasArgv
        ? { argv: requiredActionArgv(action.argv) }
        : { command: requiredActionString(action.command, 'command', 32_768) }),
      ...(action.timeoutMs === undefined ? {} : { timeoutMs: boundedInteger(action.timeoutMs, 'timeoutMs', 1_000, 30 * 60_000) }),
    }
  }
  throw runtimeError('featurebench_action_tool_unknown', `Unknown FeatureBench tool: ${tool}`)
}

async function executeAction(action: AgentAction, workspace: string, defaultTimeoutMs: number) {
  if (action.tool === 'read_file') {
    const target = await existingWorkspacePath(workspace, action.path)
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw runtimeError('featurebench_tool_path_invalid', `${action.path} is not a file.`)
    const content = await fs.readFile(target, 'utf8')
    const lines = content.split(/\r?\n/)
    const start = action.startLine ?? 1
    const end = Math.min(action.endLine ?? lines.length, lines.length)
    if (end < start) throw runtimeError('featurebench_tool_range_invalid', 'read_file endLine must be greater than or equal to startLine.')
    return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
  }
  if (action.tool === 'list_files') {
    const start = await existingWorkspacePath(workspace, action.path ?? '.')
    return (await listFiles(workspace, start, action.depth ?? 4)).join('\n')
  }
  if (action.tool === 'search') {
    const start = await existingWorkspacePath(workspace, action.path ?? '.')
    return (await searchFiles(workspace, start, action.query, action.maxResults ?? 200)).join('\n')
  }
  if (action.tool === 'write_file') {
    const target = await writableWorkspacePath(workspace, action.path)
    await ensureToolDirectory(workspace, path.dirname(target))
    await fs.writeFile(target, action.content, 'utf8')
    await applyToolOwnership(target)
    return `wrote ${Buffer.byteLength(action.content)} bytes to ${relativeDisplay(workspace, target)}`
  }
  if (action.tool === 'delete_file') {
    const target = await existingWorkspacePath(workspace, action.path)
    const stat = await fs.lstat(target)
    if (!stat.isFile() && !stat.isSymbolicLink()) throw runtimeError('featurebench_tool_delete_invalid', 'delete_file accepts only a file or symbolic link.')
    await fs.unlink(target)
    return `deleted ${relativeDisplay(workspace, target)}`
  }
  if (action.tool === 'apply_patch') {
    const result = await spawnWithInput('git', ['apply', '--whitespace=nowarn', '-'], action.patch, {
      cwd: workspace,
      timeoutMs: defaultTimeoutMs,
    })
    if (result.exitCode !== 0) throw runtimeError('featurebench_tool_patch_failed', compactCommandOutput(result))
    return compactCommandOutput(result) || 'patch applied'
  }
  const timeoutMs = Math.min(action.timeoutMs ?? defaultTimeoutMs, 30 * 60_000)
  const result = action.argv
    ? await runArgv(action.argv, workspace, timeoutMs)
    : await runShell(action.command, workspace, timeoutMs)
  if (result.exitCode !== 0) throw runtimeError(
    action.tool === 'test' ? 'featurebench_tool_test_failed' : 'featurebench_tool_shell_failed',
    compactCommandOutput(result),
  )
  return compactCommandOutput(result) || `command completed with exit code ${result.exitCode}`
}

async function runShell(command: string, cwd: string, timeoutMs: number) {
  const identity = toolIdentity()
  try {
    const result = await execFileAsync('/bin/bash', ['-lc', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OBSERVATION_BYTES * 4,
      encoding: 'utf8',
      env: safeToolEnvironment(),
      ...identity,
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    const exitCode = typeof failure.code === 'number' ? failure.code : failure.killed ? 124 : 1
    return { exitCode, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message }
  }
}

async function runArgv(argv: string[], cwd: string, timeoutMs: number) {
  try {
    const result = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OBSERVATION_BYTES * 4,
      encoding: 'utf8',
      env: safeToolEnvironment(),
      ...toolIdentity(),
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    const exitCode = typeof failure.code === 'number' ? failure.code : failure.killed ? 124 : 1
    return { exitCode, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message }
  }
}

async function spawnWithInput(command: string, args: string[], input: string, options: { cwd: string; timeoutMs: number }) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeToolEnvironment(),
      ...toolIdentity(),
    })
    let stdout = ''
    let stderr = ''
    const collect = (current: string, chunk: Buffer) => boundedText(current + chunk.toString('utf8'), MAX_OBSERVATION_BYTES * 4).text
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk) })
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

async function listFiles(workspace: string, start: string, maxDepth: number) {
  const output: string[] = []
  const visit = async (directory: string, depth: number) => {
    if (output.length >= MAX_LIST_ENTRIES || depth > maxDepth) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (output.length >= MAX_LIST_ENTRIES) break
      if (entry.name === '.git') continue
      const fullPath = path.join(directory, entry.name)
      const relative = relativeDisplay(workspace, fullPath)
      output.push(entry.isDirectory() ? `${relative}/` : relative)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(fullPath, depth + 1)
    }
  }
  const stat = await fs.stat(start)
  if (stat.isDirectory()) await visit(start, 0)
  else output.push(relativeDisplay(workspace, start))
  if (output.length >= MAX_LIST_ENTRIES) output.push(`[truncated after ${MAX_LIST_ENTRIES} entries]`)
  return output
}

async function searchFiles(workspace: string, start: string, query: string, maxResults: number) {
  const output: string[] = []
  let filesVisited = 0
  const visit = async (target: string) => {
    if (output.length >= maxResults || filesVisited >= MAX_SEARCH_FILES) return
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git' || output.length >= maxResults || filesVisited >= MAX_SEARCH_FILES) continue
        await visit(path.join(target, entry.name))
      }
      return
    }
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return
    filesVisited += 1
    const buffer = await fs.readFile(target)
    if (buffer.includes(0)) return
    const lines = buffer.toString('utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length && output.length < maxResults; index += 1) {
      if (lines[index]!.includes(query)) output.push(`${relativeDisplay(workspace, target)}:${index + 1}:${lines[index]}`)
    }
  }
  await visit(start)
  if (filesVisited >= MAX_SEARCH_FILES) output.push(`[search stopped after ${MAX_SEARCH_FILES} files]`)
  if (output.length >= maxResults) output.push(`[truncated after ${maxResults} matches]`)
  return output
}

async function existingWorkspacePath(workspace: string, input: string) {
  const candidate = candidateWorkspacePath(workspace, input)
  const real = await fs.realpath(candidate)
  assertInsideWorkspace(workspace, real)
  return real
}

async function writableWorkspacePath(workspace: string, input: string) {
  const candidate = candidateWorkspacePath(workspace, input)
  let parent = path.dirname(candidate)
  for (;;) {
    try {
      const realParent = await fs.realpath(parent)
      assertInsideWorkspace(workspace, realParent)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const next = path.dirname(parent)
      if (next === parent) throw runtimeError('featurebench_tool_path_escape', 'Tool path escapes the FeatureBench workspace.')
      parent = next
    }
  }
  try {
    const existing = await fs.realpath(candidate)
    assertInsideWorkspace(workspace, existing)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return candidate
}

function candidateWorkspacePath(workspace: string, input: string) {
  if (!input || input.includes('\0')) throw runtimeError('featurebench_tool_path_invalid', 'Tool path is invalid.')
  const candidate = path.resolve(workspace, input)
  assertInsideWorkspace(workspace, candidate)
  return candidate
}

function assertInsideWorkspace(workspace: string, candidate: string) {
  const relative = path.relative(workspace, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw runtimeError('featurebench_tool_path_escape', 'Tool path escapes the FeatureBench workspace.')
  }
}

async function canonicalDirectory(input: string, label: string) {
  const real = await fs.realpath(path.resolve(input))
  if (!(await fs.stat(real)).isDirectory()) throw runtimeError('featurebench_workspace_invalid', `${label} must be a directory.`)
  return real
}

function featureBenchSystemPrompt(instruction: string) {
  return `You are the Tokenless coding agent running inside an official FeatureBench task container.

The exact upstream FeatureBench problem_statement follows between the delimiters. Do not reinterpret or shorten it.

<featurebench_problem_statement>
${instruction}
</featurebench_problem_statement>

Work only in /testbed. Inspect the repository, implement the complete feature, and run relevant tests. Hidden evaluator tests and gold patches are unavailable and must never be requested.

Respond with exactly one JSON object and no Markdown. The schema is:
{"actions":[<zero to eight actions>],"done":<boolean>,"summary":<optional string>}

The response must parse with JSON.parse. Prefer single quotes inside shell command strings; JSON-escape every embedded double quote and backslash.

Available actions:
- {"tool":"read_file","path":"relative/path","startLine":1,"endLine":200}
- {"tool":"list_files","path":".","depth":4}
- {"tool":"search","query":"literal text","path":".","maxResults":200}
- {"tool":"write_file","path":"relative/path","content":"complete file content"}
- {"tool":"delete_file","path":"relative/path"}
- {"tool":"apply_patch","patch":"a unified git diff"}
- {"tool":"shell","argv":["git","status","--short"],"timeoutMs":120000}
- {"tool":"test","argv":["python","-m","pytest","tests/test_target.py","-q"],"timeoutMs":120000}
- The command field is also accepted instead of argv when shell syntax is required; use single quotes inside that JSON string.

Request every currently useful independent action in one batch. Use done=false while tools are needed. Use done=true with an empty actions array only after the implementation and focused tests are complete. Do not claim success in prose; the official FeatureBench evaluator decides the result.`
}

function observationPrompt(step: number, observations: ToolObservation[], validationFailures: number) {
  const payload = observations.map((observation) => ({
    index: observation.index,
    tool: observation.tool,
    ok: observation.ok,
    output: observation.output,
    truncated: observation.truncated,
    durationMs: observation.durationMs,
  }))
  return `Tool batch result for step ${step - 1}:
${JSON.stringify(payload)}

The action schema and all tools declared in the first message remain available. Prefer argv for shell and test actions.

${validationFailures > 0 ? 'Your prior response failed action validation. Correct the exact error shown above. Return only one valid JSON object; prefer argv, or use single quotes inside command and JSON-escape every embedded double quote and backslash.\n\n' : ''}Continue the same FeatureBench task. Batch all currently useful actions. Set done=true only when the repository implementation and focused tests are complete.`
}

function renderTranscript(messages: Array<{ role: 'user' | 'assistant'; text: string }>) {
  return messages.map((message) => `[${message.role}]\n${message.text}`).join('\n\n')
}

function stripCodeFence(value: string) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value)
  return match?.[1] ?? value
}

function publicAction(action: AgentAction) {
  if (action.tool === 'write_file') return { ...action, content: `<${Buffer.byteLength(action.content)} bytes sha256=${sha256(action.content)}>` }
  if (action.tool === 'apply_patch') return { ...action, patch: `<${Buffer.byteLength(action.patch)} bytes sha256=${sha256(action.patch)}>` }
  return action
}

async function ensureToolDirectory(workspace: string, directory: string) {
  const relative = path.relative(workspace, directory)
  if (!relative) return
  let current = workspace
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let created = false
    try {
      await fs.mkdir(current)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (created) await applyToolOwnership(current)
  }
}

async function applyToolOwnership(target: string) {
  const identity = toolIdentity()
  if (identity.uid !== undefined && identity.gid !== undefined) {
    await fs.chown(target, identity.uid, identity.gid)
  }
}

function toolIdentity(): { uid?: number; gid?: number } {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    return { uid: 65534, gid: 65534 }
  }
  return {}
}

function safeToolEnvironment() {
  const output: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/token|cookie|authorization|session|password|secret|credential/i.test(key)) continue
    output[key] = value
  }
  output.HOME = '/tmp/tokenless-featurebench-tools'
  return output
}

function redactSecrets(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:token|cookie|authorization|session|password|secret|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

function compactCommandOutput(result: { exitCode: number; stdout: string; stderr: string }) {
  return [`exit_code=${result.exitCode}`, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
}

function relativeDisplay(workspace: string, target: string) {
  const value = path.relative(workspace, target)
  return value === '' ? '.' : value.split(path.sep).join('/')
}

function boundedText(value: string, bytes: number) {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= bytes) return { text: value, truncated: false }
  return { text: `${buffer.subarray(0, bytes).toString('utf8')}\n[truncated]`, truncated: true }
}

function normalizeActionRecord(value: unknown) {
  const outer = plainRecord(value)
  let action = outer
  if (outer.args !== undefined) {
    if (Object.keys(outer).some((key) => !['tool', 'args'].includes(key))) {
      throw runtimeError('featurebench_action_unknown_field', 'An args-wrapped action contains an unknown field.')
    }
    const args = plainRecord(outer.args)
    if ('tool' in args) throw runtimeError('featurebench_action_unknown_field', 'An action args object cannot contain tool.')
    action = { tool: outer.tool, ...args }
  }
  const aliases = [
    ['start_line', 'startLine'],
    ['end_line', 'endLine'],
    ['max_results', 'maxResults'],
    ['timeout_ms', 'timeoutMs'],
  ] as const
  for (const [alias, canonical] of aliases) {
    if (action[alias] === undefined) continue
    if (action[canonical] !== undefined) {
      throw runtimeError('featurebench_action_invalid', `Action cannot contain both ${alias} and ${canonical}.`)
    }
    action = { ...action, [canonical]: action[alias] }
    delete action[alias]
  }
  return action
}

function requiredActionArgv(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw runtimeError('featurebench_action_invalid', 'argv must contain from 1 through 256 string arguments.')
  }
  const argv = value.map((argument, index) => requiredActionString(argument, `argv[${index}]`, 8_192, true))
  if (Buffer.byteLength(JSON.stringify(argv)) > 32_768) {
    throw runtimeError('featurebench_action_invalid', 'argv must be no larger than 32768 bytes.')
  }
  return argv
}

function requiredActionString(value: unknown, field: string, maxBytes = 8_192, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maxBytes) {
    throw runtimeError('featurebench_action_invalid', `${field} must be a ${allowEmpty ? '' : 'non-empty '}string no larger than ${maxBytes} bytes.`)
  }
  return value
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw runtimeError('featurebench_value_invalid', `${field} must be an integer from ${min} through ${max}.`)
  }
  return Number(value)
}

function assertPromptSize(value: string) {
  if (Buffer.byteLength(value) > MAX_PROMPT_BYTES) {
    throw runtimeError('featurebench_context_limit', `FeatureBench provider context exceeds ${MAX_PROMPT_BYTES} bytes.`)
  }
}

function plainRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw runtimeError('featurebench_value_invalid', 'Expected a JSON object.')
  return value as Record<string, any>
}

async function requestJsonWithTimeout(
  url: string,
  init: { method: 'POST', headers: Record<string, string>, body?: string },
  timeoutMs: number,
) {
  return await new Promise<{ status: number, ok: boolean, body: Record<string, any> }>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const settleResolve = (value: { status: number, ok: boolean, body: Record<string, any> }) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(value)
    }
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      reject(error)
    }
    const rejectTransport = (error: unknown) => {
      const code = errorCode(error)
      if (code === 'featurebench_provider_turn_timeout' || code === 'featurebench_channel_response_invalid') {
        settleReject(error)
        return
      }
      settleReject(runtimeError(
        'featurebench_channel_unavailable',
        error instanceof Error ? error.message : String(error),
      ))
    }
    const request = http.request(url, { method: init.method, headers: init.headers }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_CHANNEL_RESPONSE_BYTES) {
          settleReject(runtimeError(
            'featurebench_channel_response_invalid',
            'FeatureBench channel response exceeded the size limit.',
          ))
          request.destroy()
          return
        }
        chunks.push(buffer)
      })
      response.once('error', rejectTransport)
      response.once('end', () => {
        if (settled) return
        const status = response.statusCode ?? 0
        try {
          settleResolve({
            status,
            ok: status >= 200 && status < 300,
            body: plainRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
          })
        } catch {
          settleReject(runtimeError(
            'featurebench_channel_response_invalid',
            `FeatureBench channel returned non-JSON HTTP ${status}.`,
          ))
        }
      })
    })
    request.once('error', rejectTransport)
    timeout = setTimeout(() => {
      settleReject(runtimeError(
        'featurebench_provider_turn_timeout',
        `FeatureBench provider turn exceeded ${timeoutMs} ms.`,
      ))
      request.destroy()
    }, timeoutMs)
    request.end(init.body)
  })
}

function runtimeError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

function errorCode(error: unknown) {
  return typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'featurebench_agent_failed'
}

function classifyRuntimeFailure(error: unknown) {
  const category = (error as { category?: unknown })?.category
  if (typeof category === 'string') return category
  const code = errorCode(error)
  if (code.includes('action')) return 'action_validation'
  if (code.includes('tool')) return 'tool_execution'
  return code.includes('provider') || code.includes('channel') ? 'provider_turn' : 'agent_runtime'
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

class EventWriter {
  private sequence = 0

  constructor(private readonly file: string, private readonly channel: FeatureBenchChannelFile) {}

  async write(type: string, data: Record<string, unknown>) {
    await fs.mkdir(path.dirname(path.resolve(this.file)), { recursive: true })
    const event = {
      protocol: FEATUREBENCH_AGENT_PROTOCOL,
      sequence: ++this.sequence,
      type,
      at: new Date().toISOString(),
      instanceId: this.channel.instanceId,
      benchmarkCommit: FEATUREBENCH_BENCHMARK_COMMIT,
      datasetRevision: FEATUREBENCH_DATASET_REVISION,
      provider: this.channel.provider,
      model: this.channel.model,
      executionMode: this.channel.executionMode,
      ...data,
    }
    await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
