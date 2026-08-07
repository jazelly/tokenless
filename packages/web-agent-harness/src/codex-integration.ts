import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  CODEX_HOOK_PROTOCOL,
  type CodexContextInspection,
  type CodexHookInput,
  type CodexHookResult,
  type CodexIntegrationInput,
  type CodexIntegrationStatus,
} from './agent-contracts.js'
import { AgentContextStore } from './agent-context-store.js'
import { readCodexThreadFromAppServer } from './codex-app-server.js'

const GUIDANCE_START = '<!-- tokenless-codex-guidance v1 -->'
const GUIDANCE_END = '<!-- /tokenless-codex-guidance -->'
const TOKENLESS_HOOK_MARKER = 'tokenless-agent-hook-v1'
const SUPPORTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const

export async function installCodexIntegration(input: CodexIntegrationInput): Promise<CodexIntegrationStatus> {
  const resolved = await resolveIntegrationInput(input, true)
  const guidancePath = await effectiveGuidancePath(resolved.codexHome)
  const hooksPath = path.join(resolved.codexHome, 'hooks.json')
  const previousGuidance = await readOptionalFile(guidancePath)
  const previousHooks = await readOptionalFile(hooksPath)
  const nextGuidance = upsertGuidance(previousGuidance ?? '')
  const nextHooks = mergeHooks(parseHooksFile(previousHooks, hooksPath), hookCommand(resolved))

  await writeAtomic(guidancePath, nextGuidance)
  try {
    await writeAtomic(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`)
  } catch (error) {
    await restoreFile(guidancePath, previousGuidance).catch(() => undefined)
    throw error
  }
  return await inspectCodexIntegration(resolved)
}

export async function uninstallCodexIntegration(input: CodexIntegrationInput): Promise<CodexIntegrationStatus> {
  const resolved = await resolveIntegrationInput(input, false)
  const guidancePath = await effectiveGuidancePath(resolved.codexHome)
  const hooksPath = path.join(resolved.codexHome, 'hooks.json')
  const previousGuidance = await readOptionalFile(guidancePath)
  const previousHooks = await readOptionalFile(hooksPath)
  const nextGuidance = removeGuidance(previousGuidance ?? '')
  const nextHooks = removeHooks(parseHooksFile(previousHooks, hooksPath))

  if (previousGuidance !== null) await writeAtomic(guidancePath, nextGuidance)
  try {
    if (previousHooks !== null) await writeAtomic(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`)
  } catch (error) {
    if (previousGuidance !== null) await restoreFile(guidancePath, previousGuidance).catch(() => undefined)
    throw error
  }
  return await inspectCodexIntegration(resolved)
}

export async function inspectCodexIntegration(input: CodexIntegrationInput): Promise<CodexIntegrationStatus> {
  const resolved = await resolveIntegrationInput(input, false)
  const guidancePath = await effectiveGuidancePath(resolved.codexHome)
  const hooksPath = path.join(resolved.codexHome, 'hooks.json')
  const guidance = await readOptionalFile(guidancePath)
  const rawHooks = await readOptionalFile(hooksPath)
  const hooks = parseHooksFile(rawHooks, hooksPath)
  const installedEvents = installedHookEvents(hooks)
  const databasePath = path.join(resolved.tokenlessHome, 'harness.sqlite3')
  const databaseExists = await fileExists(databasePath)
  const store = databaseExists ? await AgentContextStore.open(resolved.tokenlessHome) : null
  try {
    return {
      protocol: CODEX_HOOK_PROTOCOL,
      agent: 'codex',
      codexHome: resolved.codexHome,
      tokenlessHome: resolved.tokenlessHome,
      guidance: {
        installed: hasGuidance(guidance ?? ''),
        path: guidancePath,
        usesOverride: path.basename(guidancePath) === 'AGENTS.override.md',
      },
      hooks: {
        installed: installedEvents.length === SUPPORTED_HOOK_EVENTS.length,
        path: hooksPath,
        events: installedEvents,
        trustRequired: true,
      },
      context: {
        databasePath,
        ...(store?.counts() ?? { projects: 0, conversations: 0, turns: 0, invocations: 0 }),
      },
    }
  } finally {
    store?.close()
  }
}

export async function inspectCodexContext({
  tokenlessHome,
  chatId,
}: {
  tokenlessHome: string
  chatId: string
}): Promise<CodexContextInspection> {
  if (!await fileExists(path.join(path.resolve(tokenlessHome), 'harness.sqlite3'))) {
    throw new Error('Tokenless Harness has not observed any Codex context yet.')
  }
  const store = await AgentContextStore.open(path.resolve(tokenlessHome))
  try {
    return store.inspectCodexConversation(nonempty(chatId, 'chatId'))
  } finally {
    store.close()
  }
}

export async function handleCodexHook({
  tokenlessHome,
  codexHome,
  input,
}: {
  tokenlessHome: string
  codexHome: string
  input: unknown
}): Promise<CodexHookResult> {
  const hook = validateHookInput(input)
  const store = await AgentContextStore.open(path.resolve(tokenlessHome))
  try {
    if (hook.hook_event_name === 'SessionStart') {
      store.observeCodexSession({
        chatId: hook.session_id,
        cwd: hook.cwd,
        model: hook.model,
      })
      return {}
    }
    if (hook.hook_event_name === 'UserPromptSubmit') {
      store.observeCodexTurn({
        chatId: hook.session_id,
        turnId: requiredHookField(hook.turn_id, 'turn_id'),
        cwd: hook.cwd,
        model: hook.model,
        prompt: requiredHookField(hook.prompt, 'prompt'),
      })
      return {}
    }
    if (hook.hook_event_name === 'Stop') {
      store.completeCodexTurn(hook.session_id, requiredHookField(hook.turn_id, 'turn_id'))
      return {}
    }
    if (hook.hook_event_name === 'SessionEnd') return {}
    if (hook.hook_event_name === 'PostToolUse') {
      if (!isTokenlessToolUse(hook)) return {}
      store.completeCodexInvocation({
        chatId: hook.session_id,
        toolCallId: requiredHookField(hook.tool_use_id, 'tool_use_id'),
        outcome: extractTokenlessOutcome(hook.tool_response),
      })
      return {}
    }
    if (hook.hook_event_name !== 'PreToolUse' || !isTokenlessToolUse(hook)) return {}

    const appServerThread = await readCodexThreadFromAppServer({
      threadId: hook.session_id,
      codexHome: path.resolve(codexHome),
    }).catch(() => null)
    const context = store.createCodexInvocation({
      chatId: hook.session_id,
      turnId: requiredHookField(hook.turn_id, 'turn_id'),
      toolCallId: requiredHookField(hook.tool_use_id, 'tool_use_id'),
      toolName: requiredHookField(hook.tool_name, 'tool_name'),
      toolInput: hook.tool_input,
      cwd: hook.cwd,
      model: hook.model,
      appServerThread,
    })
    return preToolUseOutput(hook, context)
  } finally {
    store.close()
  }
}

function preToolUseOutput(hook: CodexHookInput, context: ReturnType<AgentContextStore['createCodexInvocation']>) {
  const toolName = requiredHookField(hook.tool_name, 'tool_name')
  const environment = {
    TOKENLESS_CONTEXT_BINDING_ID: context.bindingId,
    TOKENLESS_AGENT_KIND: context.agentKind,
    TOKENLESS_AGENT_SESSION_ID: context.agentChatId,
    TOKENLESS_AGENT_TURN_ID: context.agentTurnId,
    TOKENLESS_AGENT_TOOL_CALL_ID: context.agentToolCallId,
    TOKENLESS_PROJECT_ID: context.project.projectId,
    TOKENLESS_CONVERSATION_ID: context.conversationId,
    TOKENLESS_TASK_ID: context.providerTaskId,
    TOKENLESS_PROJECT_NAME: context.project.providerProjectName,
    TOKENLESS_CHAT_NAME: `Codex ${context.agentChatId.slice(0, 12)}`,
    ...(context.agentSessionTreeId
      ? { TOKENLESS_AGENT_SESSION_TREE_ID: context.agentSessionTreeId }
      : {}),
    ...(context.activeProvider ? { TOKENLESS_PROVIDER: context.activeProvider } : {}),
    ...(context.activeProfile ? { TOKENLESS_PROFILE: context.activeProfile } : {}),
  }
  const updatedInput = toolName === 'Bash'
    ? {
        ...jsonRecord(hook.tool_input),
        command: injectShellEnvironment(requiredShellCommand(hook.tool_input), environment),
      }
    : {
        ...jsonRecord(hook.tool_input),
        tokenlessContext: {
          protocol: context.protocol,
          bindingId: context.bindingId,
          projectId: context.project.projectId,
          conversationId: context.conversationId,
          chatId: context.agentChatId,
          turnId: context.agentTurnId,
          sessionTreeId: context.agentSessionTreeId,
          taskId: context.providerTaskId,
        },
      }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  }
}

function isTokenlessToolUse(hook: CodexHookInput) {
  if (typeof hook.tool_name !== 'string') return false
  if (/^mcp__tokenless(?:__|$)/.test(hook.tool_name)) return true
  if (hook.tool_name !== 'Bash') return false
  const command = requiredShellCommand(hook.tool_input)
  return /(?:^|[\s;&|()])(?:npx\s+|rtk\s+)?(?:["'][^"']*[\\/])?tokenless(?:["'])?(?=\s|$)/m.test(command)
}

function injectShellEnvironment(command: string, environment: Record<string, string>) {
  if (process.platform === 'win32') {
    const assignments = Object.entries(environment).map(([key, value]) => (
      `$env:${key} = '${value.replace(/'/g, "''")}'`
    ))
    return `${assignments.join('; ')}; ${command}`
  }
  const assignments = Object.entries(environment).map(([key, value]) => (
    `export ${key}=${shellQuote(value)}`
  ))
  return `${assignments.join('\n')}\n${command}`
}

function extractTokenlessOutcome(value: unknown) {
  const payload = tokenlessPayload(value)
  const profile = jsonRecord(payload?.profile)
  const providerContext = jsonRecord(payload?.providerContext)
  const project = jsonRecord(providerContext.project)
  const conversation = jsonRecord(providerContext.conversation)
  return {
    ok: typeof payload?.ok === 'boolean' ? payload.ok : null,
    provider: optionalString(payload?.provider),
    profile: optionalString(profile.slug ?? profile.id),
    jobId: optionalString(payload?.jobId ?? payload?.job_id),
    taskId: optionalString(payload?.taskId ?? payload?.task_id),
    providerProjectId: optionalString(project.resource_id ?? project.resourceId),
    providerConversationRef: optionalString(conversation.canonical_url ?? conversation.canonicalUrl),
  }
}

function tokenlessPayload(value: unknown): Record<string, any> | null {
  if (typeof value === 'string') {
    const source = value.trim()
    try {
      return jsonRecord(JSON.parse(source))
    } catch {
      const start = source.indexOf('{')
      const end = source.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          return jsonRecord(JSON.parse(source.slice(start, end + 1)))
        } catch {
          return null
        }
      }
      return null
    }
  }
  const record = jsonRecord(value)
  if (!record) return null
  for (const key of ['structuredContent', 'content', 'output', 'result']) {
    const nested = record[key]
    if (typeof nested === 'string') {
      const parsed = tokenlessPayload(nested)
      if (parsed) return parsed
    }
    const nestedRecord = jsonRecord(nested)
    if (nestedRecord && (nestedRecord.jobId || nestedRecord.taskId || typeof nestedRecord.ok === 'boolean')) {
      return nestedRecord
    }
  }
  return record
}

function hookCommand(input: Awaited<ReturnType<typeof resolveIntegrationInput>>) {
  const common = [
    shellQuote(input.command.executable),
    shellQuote(input.command.script),
    'agents',
    'hook',
    'codex',
    '--home',
    shellQuote(input.tokenlessHome),
    '--codex-home',
    shellQuote(input.codexHome),
    '--integration-id',
    TOKENLESS_HOOK_MARKER,
  ].join(' ')
  return common
}

function mergeHooks(value: Record<string, any>, command: string) {
  const hooks = jsonRecord(value.hooks) ?? {}
  const merged = { ...value, hooks: { ...hooks } }
  for (const event of SUPPORTED_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    const filtered = removeTokenlessGroups(groups)
    filtered.push(hookGroup(event, command))
    merged.hooks[event] = filtered
  }
  return merged
}

function removeHooks(value: Record<string, any>) {
  const hooks = jsonRecord(value.hooks) ?? {}
  const nextHooks = { ...hooks }
  for (const event of SUPPORTED_HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue
    const filtered = removeTokenlessGroups(hooks[event])
    if (filtered.length === 0) delete nextHooks[event]
    else nextHooks[event] = filtered
  }
  return { ...value, hooks: nextHooks }
}

function hookGroup(event: typeof SUPPORTED_HOOK_EVENTS[number], command: string) {
  return {
    ...(event === 'PreToolUse' || event === 'PostToolUse'
      ? { matcher: '^(Bash|mcp__tokenless(?:__.*)?)$' }
      : {}),
    hooks: [{
      type: 'command',
      command,
      timeout: event === 'SessionEnd' ? 3 : 5,
      ...(event === 'PreToolUse' ? { statusMessage: 'Binding Tokenless conversation context' } : {}),
    }],
  }
}

function removeTokenlessGroups(groups: unknown[]) {
  return groups.flatMap((group) => {
    const record = jsonRecord(group)
    if (!record || !Array.isArray(record.hooks)) return [group]
    const handlers = record.hooks.filter((handler: unknown) => !isTokenlessHandler(handler))
    return handlers.length === 0 ? [] : [{ ...record, hooks: handlers }]
  })
}

function installedHookEvents(value: Record<string, any>) {
  const hooks = jsonRecord(value.hooks) ?? {}
  return SUPPORTED_HOOK_EVENTS.filter((event) => (
    Array.isArray(hooks[event]) && hooks[event].some((group: unknown) => {
      const record = jsonRecord(group)
      return Array.isArray(record.hooks) && record.hooks.some(isTokenlessHandler)
    })
  ))
}

function isTokenlessHandler(value: unknown) {
  const handler = jsonRecord(value)
  return handler.type === 'command' &&
    typeof handler.command === 'string' &&
    handler.command.includes(TOKENLESS_HOOK_MARKER)
}

function upsertGuidance(value: string) {
  const without = removeGuidance(value).trimEnd()
  return `${without}${without ? '\n\n' : ''}${guidanceBlock()}\n`
}

function removeGuidance(value: string) {
  const start = value.indexOf(GUIDANCE_START)
  if (start < 0) return value
  const end = value.indexOf(GUIDANCE_END, start)
  if (end < 0) throw new Error('Tokenless guidance marker is incomplete; refusing to edit the instruction file.')
  return `${value.slice(0, start).trimEnd()}${value.slice(end + GUIDANCE_END.length)}`.trimEnd() + '\n'
}

function hasGuidance(value: string) {
  const start = value.indexOf(GUIDANCE_START)
  const end = value.indexOf(GUIDANCE_END)
  return start >= 0 && end > start
}

function guidanceBlock() {
  return [
    GUIDANCE_START,
    '## Tokenless delegation',
    '',
    'Tokenless is an optional visible-provider delegation path. Continue using Codex normally for local reasoning, edits, and verification.',
    '',
    '- Delegate shareable Q&A, research, critique, or long-form synthesis when a visible provider is useful and the task does not require direct workspace writes.',
    '- Invoke the globally installed `tokenless` command directly. Do not use `npx`, wrap the `codex` executable, or start Codex through Tokenless.',
    '- Do not invent or manually copy Codex chat, turn, session, project, or conversation identifiers. Installed lifecycle hooks bind them to each Tokenless invocation.',
    '- For later delegation in the same Codex chat, keep the hook-provided Tokenless task identity so the Harness can continue the same provider conversation.',
    '- Share only user-authorized prompts and files. Never send hidden reasoning, credentials, browser state, secrets, or unrelated project content.',
    GUIDANCE_END,
  ].join('\n')
}

async function effectiveGuidancePath(codexHome: string) {
  const override = path.join(codexHome, 'AGENTS.override.md')
  const overrideContent = await readOptionalFile(override)
  return overrideContent?.trim() ? override : path.join(codexHome, 'AGENTS.md')
}

async function resolveIntegrationInput(input: CodexIntegrationInput, create: boolean) {
  const codexHome = path.resolve(nonempty(input.codexHome, 'codexHome'))
  const tokenlessHome = path.resolve(nonempty(input.tokenlessHome, 'tokenlessHome'))
  if (create) {
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 })
    await fs.mkdir(tokenlessHome, { recursive: true, mode: 0o700 })
  }
  return {
    codexHome,
    tokenlessHome,
    command: {
      executable: path.resolve(nonempty(input.command.executable, 'command.executable')),
      script: path.resolve(nonempty(input.command.script, 'command.script')),
    },
  }
}

function parseHooksFile(value: string | null, hooksPath: string) {
  if (value === null || !value.trim()) return { description: 'Tokenless and user-configured Codex lifecycle hooks.', hooks: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Cannot install Tokenless because ${hooksPath} is not valid JSON.`)
  }
  const record = jsonRecordOrNull(parsed)
  if (!record || (record.hooks !== undefined && !jsonRecordOrNull(record.hooks))) {
    throw new Error(`Cannot install Tokenless because ${hooksPath} does not contain a hooks object.`)
  }
  const hooks = jsonRecordOrNull(record.hooks)
  for (const event of SUPPORTED_HOOK_EVENTS) {
    if (hooks?.[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`Cannot install Tokenless because ${hooksPath} has a non-array ${event} hook group.`)
    }
  }
  return record
}

function validateHookInput(value: unknown): CodexHookInput {
  const input = jsonRecord(value)
  if (!input) throw new Error('Codex hook input must be a JSON object.')
  for (const field of ['session_id', 'cwd', 'hook_event_name']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      throw new Error(`Codex hook input requires ${field}.`)
    }
  }
  if (!SUPPORTED_HOOK_EVENTS.includes(input.hook_event_name as any)) {
    throw new Error(`Unsupported Codex hook event: ${input.hook_event_name}`)
  }
  return input as CodexHookInput
}

function requiredHookField(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) throw new Error(`Codex hook input requires ${field}.`)
  return value
}

function requiredShellCommand(value: unknown) {
  const input = jsonRecord(value)
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw new Error('Codex Bash hook input requires tool_input.command.')
  }
  return input.command
}

async function readOptionalFile(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeAtomic(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, filePath)
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600)
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
  }
}

async function restoreFile(filePath: string, content: string | null) {
  if (content === null) {
    await fs.unlink(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    return
  }
  await writeAtomic(filePath, content)
}

function shellQuote(value: string) {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function jsonRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

function jsonRecordOrNull(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

function nonempty(value: string, field: string) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string without NUL bytes.`)
  }
  return value
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
