import { createHash, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  AGENT_CONTEXT_PROTOCOL,
  type AgentConversationContext,
  type AgentInvocationContext,
  type AgentInvocationOutcome,
  type CodexAppServerThread,
  type CodexContextInspection,
} from './contracts.js'
import { migrateDatabase } from 'tokenless-internal-shared/database/migrate.js'

const DATABASE_FILE = 'tokenless.sqlite3'

type StoredTurn = {
  turnId: string
  promptSha256: string | null
  startedAt: string
  completedAt: string | null
}

type StoredInvocation = {
  bindingId: string
  hookSessionId: string | null
  agentTurnId: string
  agentToolCallId: string
  toolName: string
  toolInputSha256: string
  status: string
  provider: string | null
  profile: string | null
  jobId: string | null
  createdAt: string
  updatedAt: string
}

type StoredProviderBinding = {
  provider: string
  profile: string | null
  lastJobId: string | null
  providerProjectId: string | null
  providerConversationRef: string | null
  firstSeenAt: string
  lastSeenAt: string
}

type StoredContext = {
  conversation: AgentConversationContext
  turns: StoredTurn[]
  invocations: StoredInvocation[]
  providerBindings: StoredProviderBinding[]
}

type StoredContextRow = {
  chatId: string
  context: StoredContext
}

export class AgentContextStore {
  readonly homeDir: string
  readonly databasePath: string

  #db: DatabaseSync
  #closed = false

  static async open(homeDir: string) {
    const requested = path.resolve(homeDir)
    await fs.mkdir(requested, { recursive: true, mode: 0o700 })
    const canonical = await fs.realpath(requested)
    const store = new AgentContextStore(canonical)
    try {
      store.initialize()
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  private constructor(homeDir: string) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE)
    this.#db = new DatabaseSync(this.databasePath)
    this.#db.exec('PRAGMA busy_timeout = 3000;')
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  observeCodexSession({ chatId, cwd, model, sessionTreeId, appServerThread }: {
    chatId: string
    cwd: string
    model?: string | undefined
    sessionTreeId?: string | null | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }) {
    this.transaction(() => this.upsertCodexSession({ chatId, cwd, model, sessionTreeId, appServerThread }))
    return this.conversation(chatId)
  }

  observeCodexTurn({ chatId, turnId, cwd, model, prompt }: {
    chatId: string
    turnId: string
    cwd: string
    model?: string | undefined
    prompt?: string | undefined
  }) {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.upsertCodexSession({ chatId, cwd, model })
      const state = this.requireContext(chatId)
      const existing = state.context.turns.find((turn) => turn.turnId === turnId)
      if (existing) {
        existing.promptSha256 = prompt === undefined ? existing.promptSha256 : sha256(prompt)
      } else {
        state.context.turns.push({
          turnId,
          promptSha256: prompt === undefined ? null : sha256(prompt),
          startedAt: now,
          completedAt: null,
        })
      }
      this.writeContext(state)
    })
  }

  completeCodexTurn(chatId: string, turnId: string) {
    const now = new Date().toISOString()
    this.transaction(() => {
      const state = this.requireContext(chatId)
      const turn = state.context.turns.find((candidate) => candidate.turnId === turnId)
      if (turn) {
        turn.completedAt ??= now
      }
      for (const invocation of state.context.invocations) {
        if (invocation.agentTurnId === turnId && invocation.status === 'pending') {
          invocation.status = 'completed_without_result'
          invocation.updatedAt = now
        }
      }
      this.writeContext(state)
    })
  }

  createCodexInvocation({ chatId, turnId, toolCallId, toolName, toolInput, cwd, model, sessionTreeId, appServerThread }: {
    chatId: string
    turnId: string
    toolCallId: string
    toolName: string
    toolInput: unknown
    cwd: string
    model?: string | undefined
    sessionTreeId?: string | null | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }): AgentInvocationContext {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.upsertCodexSession({ chatId, cwd, model, sessionTreeId, appServerThread })
      const state = this.requireContext(chatId)
      const turn = state.context.turns.find((candidate) => candidate.turnId === turnId)
      if (!turn) state.context.turns.push({ turnId, promptSha256: null, startedAt: now, completedAt: null })
      const previous = state.context.invocations.find((invocation) => invocation.agentToolCallId === toolCallId)
      const invocation: StoredInvocation = {
        bindingId: previous?.bindingId ?? `binding_${randomUUID()}`,
        hookSessionId: previous?.hookSessionId ?? chatId,
        agentTurnId: turnId,
        agentToolCallId: toolCallId,
        toolName,
        toolInputSha256: sha256(canonicalJson(toolInput)),
        status: previous?.status ?? 'pending',
        provider: previous?.provider ?? null,
        profile: previous?.profile ?? null,
        jobId: previous?.jobId ?? null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      if (previous) state.context.invocations[state.context.invocations.indexOf(previous)] = invocation
      else state.context.invocations.push(invocation)
      this.writeContext(state)
    })
    const state = this.requireContext(chatId)
    const invocation = state.context.invocations.find((candidate) => candidate.agentToolCallId === toolCallId)
    if (!invocation) throw new Error('Codex invocation was not registered.')
    return invocationContext(this.conversation(chatId), invocation.bindingId, invocation.hookSessionId, invocation.agentTurnId, invocation.agentToolCallId)
  }

  resolveCodexThreadInvocation({ chatId, cwd, sessionTreeId, bindingId, turnId, toolCallId, toolName, toolInput, model, appServerThread }: {
    chatId: string
    cwd: string
    sessionTreeId?: string | null | undefined
    bindingId?: string | null | undefined
    turnId?: string | null | undefined
    toolCallId?: string | null | undefined
    toolName?: string | null | undefined
    toolInput?: unknown
    model?: string | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }): AgentInvocationContext {
    let resolvedBindingId = ''
    let resolvedHookSessionId: string | null = null
    let resolvedTurnId = ''
    let resolvedToolCallId = ''
    this.transaction(() => {
      const project = resolveProject(cwd)
      const registered = this.readContext(chatId)
      if (registered && registered.context.conversation.project.projectId !== project.projectId) {
        throw new Error('Codex thread is already bound to a different canonical project.')
      }
      this.upsertCodexSession({ chatId, cwd, model, sessionTreeId, appServerThread })
      const matches = bindingId
        ? this.readContexts().flatMap((state) => state.context.invocations
          .filter((invocation) => invocation.bindingId === bindingId)
          .map((invocation) => ({ state, invocation })))
        : []
      if (matches.length > 1) throw new Error('Codex hook binding is ambiguous.')
      if (bindingId && matches.length === 0) throw new Error('Codex hook binding was not found.')
      const target = this.requireContext(chatId)
      const existing = matches[0]
      if (existing) {
        const hookSessionId = existing.invocation.hookSessionId
        if (!hookSessionId) throw new Error('Codex hook binding is missing immutable Hook provenance.')
        const existingTreeId = existing.state.context.conversation.agentSessionTreeId ?? hookSessionId
        if (sessionTreeId && existingTreeId !== sessionTreeId) throw new Error('Codex hook binding belongs to a different session tree.')
        const sourceTurn = existing.state.context.turns.find((turn) => turn.turnId === existing.invocation.agentTurnId)
        if (!sourceTurn) throw new Error('Codex Hook binding references a missing turn.')
        if (!target.context.turns.some((turn) => turn.turnId === sourceTurn.turnId)) target.context.turns.push({ ...sourceTurn })
        existing.state.context.invocations = existing.state.context.invocations.filter((invocation) => invocation.bindingId !== existing.invocation.bindingId)
        const now = new Date().toISOString()
        const moved = { ...existing.invocation, updatedAt: now }
        target.context.invocations = target.context.invocations.filter((invocation) => invocation.bindingId !== moved.bindingId)
        target.context.invocations.push(moved)
        if (existing.state.chatId !== target.chatId) {
          this.writeContext(existing.state)
        }
        this.writeContext(target)
        resolvedBindingId = moved.bindingId
        resolvedHookSessionId = hookSessionId
        resolvedTurnId = moved.agentTurnId
        resolvedToolCallId = moved.agentToolCallId
        return
      }
      resolvedBindingId = `binding_direct_${randomUUID()}`
      resolvedHookSessionId = null
      resolvedTurnId = turnId ?? `turn_direct_${randomUUID()}`
      resolvedToolCallId = toolCallId ?? `tool_direct_${randomUUID()}`
      const now = new Date().toISOString()
      if (!target.context.turns.some((turn) => turn.turnId === resolvedTurnId)) {
        target.context.turns.push({ turnId: resolvedTurnId, promptSha256: null, startedAt: now, completedAt: null })
      }
      target.context.invocations.push({
        bindingId: resolvedBindingId,
        hookSessionId: null,
        agentTurnId: resolvedTurnId,
        agentToolCallId: resolvedToolCallId,
        toolName: toolName ?? 'tokenless.direct',
        toolInputSha256: sha256(canonicalJson(toolInput)),
        status: 'pending',
        provider: null,
        profile: null,
        jobId: null,
        createdAt: now,
        updatedAt: now,
      })
      this.writeContext(target)
    })
    return invocationContext(this.conversation(chatId), resolvedBindingId, resolvedHookSessionId, resolvedTurnId, resolvedToolCallId)
  }

  completeCodexInvocation({ chatId, toolCallId, outcome }: {
    chatId: string
    toolCallId: string
    outcome: AgentInvocationOutcome
  }) {
    const rows = this.readContexts().flatMap((state) => state.context.invocations
      .filter((invocation) => invocation.agentToolCallId === toolCallId)
      .filter((invocation) => invocation.hookSessionId === chatId || (invocation.hookSessionId === null && state.chatId === chatId))
      .map((invocation) => ({ state, invocation })))
    if (rows.length !== 1) throw new Error(rows.length === 0 ? 'Codex Hook invocation was not registered.' : 'Codex Hook invocation provenance is ambiguous.')
    const row = rows[0]
    if (!row) throw new Error('Codex Hook invocation was not registered.')
    this.completeInvocationRecord(row.state, row.invocation, outcome)
  }

  completeBoundInvocation(bindingId: string, outcome: AgentInvocationOutcome) {
    const rows = this.readContexts().flatMap((state) => state.context.invocations
      .filter((invocation) => invocation.bindingId === bindingId)
      .map((invocation) => ({ state, invocation })))
    if (rows.length !== 1) throw new Error('Codex invocation binding was not registered.')
    const row = rows[0]
    if (!row) throw new Error('Codex invocation binding was not registered.')
    this.completeInvocationRecord(row.state, row.invocation, outcome)
  }

  private completeInvocationRecord(state: StoredContextRow, invocation: StoredInvocation, outcome: AgentInvocationOutcome) {
    if (outcome.taskId && outcome.taskId !== state.context.conversation.providerTaskId) throw new Error('Tokenless provider result belongs to a different bound task.')
    const now = new Date().toISOString()
    this.transaction(() => {
      const currentState = this.requireContext(state.chatId)
      const current = currentState.context.invocations.find((candidate) => candidate.bindingId === invocation.bindingId)
      if (!current) throw new Error('Codex invocation binding was not registered.')
      current.status = outcome.ok === true ? 'succeeded' : outcome.ok === false ? 'failed' : 'completed'
      current.provider = outcome.provider
      current.profile = outcome.profile
      current.jobId = outcome.jobId
      current.updatedAt = now
      if (outcome.provider) {
        const existing = currentState.context.providerBindings.find((binding) => binding.provider === outcome.provider && binding.profile === outcome.profile)
        const next: StoredProviderBinding = {
          provider: outcome.provider,
          profile: outcome.profile,
          lastJobId: outcome.jobId,
          providerProjectId: outcome.providerProjectId,
          providerConversationRef: outcome.providerConversationRef,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
        }
        if (existing) {
          Object.assign(existing, next)
          existing.lastJobId ??= outcome.jobId
          existing.providerProjectId ??= outcome.providerProjectId
          existing.providerConversationRef ??= outcome.providerConversationRef
        } else currentState.context.providerBindings.push(next)
        currentState.context.conversation = { ...currentState.context.conversation, activeProvider: outcome.provider, activeProfile: outcome.profile }
      }
      this.writeContext(currentState)
    })
  }

  conversation(chatId: string) {
    return this.requireContext(chatId).context.conversation
  }

  inspectCodexConversation(chatId: string): CodexContextInspection {
    const context = this.requireContext(chatId).context
    const turns = [...context.turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.turnId.localeCompare(b.turnId)).map((turn) => ({
      turnId: turn.turnId, promptSha256: turn.promptSha256, startedAt: turn.startedAt, completedAt: turn.completedAt,
    }))
    const invocations = [...context.invocations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.bindingId.localeCompare(b.bindingId)).map((invocation) => ({
      bindingId: invocation.bindingId, hookSessionId: invocation.hookSessionId, turnId: invocation.agentTurnId,
      toolCallId: invocation.agentToolCallId, toolName: invocation.toolName, status: invocation.status,
      provider: invocation.provider, profile: invocation.profile, jobId: invocation.jobId,
      providerTaskId: context.conversation.providerTaskId, createdAt: invocation.createdAt, updatedAt: invocation.updatedAt,
    }))
    const providerBindings = [...context.providerBindings].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt) || a.provider.localeCompare(b.provider)).map((binding) => ({
      provider: binding.provider, profile: binding.profile, providerTaskId: context.conversation.providerTaskId,
      providerProjectId: binding.providerProjectId, providerConversationRef: binding.providerConversationRef,
      lastJobId: binding.lastJobId, firstSeenAt: binding.firstSeenAt, lastSeenAt: binding.lastSeenAt,
    }))
    return { protocol: AGENT_CONTEXT_PROTOCOL, conversation: context.conversation, turns, invocations, providerBindings }
  }

  counts() {
    const rows = this.readContexts()
    return {
      projects: new Set(rows.map((row) => row.context.conversation.project.projectId)).size,
      conversations: rows.length,
      turns: rows.reduce((total, row) => total + row.context.turns.length, 0),
      invocations: rows.reduce((total, row) => total + row.context.invocations.length, 0),
    }
  }

  private upsertCodexSession({ chatId, cwd, model: _model, sessionTreeId, appServerThread }: {
    chatId: string
    cwd: string
    model?: string | undefined
    sessionTreeId?: string | null | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }) {
    if (sessionTreeId && appServerThread && sessionTreeId !== appServerThread.sessionId) throw new Error('Codex App Server session tree does not match the explicit Hook session tree.')
    const project = resolveProject(cwd)
    const existing = this.readContext(chatId)
    if (existing && existing.context.conversation.project.projectId !== project.projectId) throw new Error('Codex thread is already bound to a different canonical project.')
    const identity = existing?.context.conversation ?? {
      ...conversationIdentity(chatId, project),
      agentKind: 'codex' as const,
      agentChatId: chatId,
      agentSessionTreeId: null,
      parentChatId: null,
      forkedFromChatId: null,
      activeProvider: null,
      activeProfile: null,
    }
    const conversation: AgentConversationContext = {
      ...identity,
      agentSessionTreeId: sessionTreeId ?? appServerThread?.sessionId ?? identity.agentSessionTreeId,
      parentChatId: appServerThread?.parentThreadId ?? identity.parentChatId,
      forkedFromChatId: appServerThread?.forkedFromId ?? identity.forkedFromChatId,
    }
    const state: StoredContextRow = existing ?? { chatId, context: { conversation, turns: [], invocations: [], providerBindings: [] } }
    state.context.conversation = conversation
    this.writeContext(state)
    return { conversationId: conversation.conversationId, providerTaskId: conversation.providerTaskId, project: conversation.project }
  }

  private requireContext(chatId: string) {
    const state = this.readContext(chatId)
    if (!state) throw new Error(`Codex conversation is not registered: ${chatId}`)
    return state
  }

  private readContext(chatId: string): StoredContextRow | undefined {
    const row = this.#db.prepare(
      `SELECT data_json FROM harness_context_records WHERE chat_id = ?`,
    ).get(chatId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { chatId, context: parseStoredContext(row.data_json) }
  }

  private readContexts() {
    return (this.#db.prepare(
      `SELECT chat_id, data_json FROM harness_context_records`,
    ).all() as Record<string, unknown>[]).map((row) => ({
      chatId: String(row.chat_id), context: parseStoredContext(row.data_json),
    }))
  }

  private writeContext(state: StoredContextRow) {
    this.#db.prepare(
      `INSERT INTO harness_context_records (chat_id, data_json)
       VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET data_json = excluded.data_json`,
    ).run(state.chatId, JSON.stringify(state.context))
  }

  private initialize() {
    migrateDatabase(this.#db)
    if (process.platform !== 'win32') fsSync.chmodSync(this.databasePath, 0o600)
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}

function resolveProject(cwd: string) {
  let canonicalRoot = fsSync.realpathSync(path.resolve(cwd))
  let cursor = canonicalRoot
  while (true) {
    if (fsSync.existsSync(path.join(cursor, '.git'))) { canonicalRoot = cursor; break }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const digest = sha256(canonicalRoot)
  const projectId = `project_${digest.slice(0, 24)}`
  const basename = path.basename(canonicalRoot) || 'project'
  return { projectId, canonicalRoot, providerProjectName: `${basename}-${digest.slice(0, 8)}` }
}

function conversationIdentity(chatId: string, project: ReturnType<typeof resolveProject>) {
  const digest = sha256(`codex\0${chatId}`)
  return { conversationId: `conversation_${digest.slice(0, 24)}`, providerTaskId: `agent:codex:${digest.slice(0, 40)}`, project }
}

function invocationContext(conversation: AgentConversationContext, bindingId: string, hookSessionId: string | null, turnId: string, toolCallId: string): AgentInvocationContext {
  return {
    protocol: AGENT_CONTEXT_PROTOCOL, bindingId, hookSessionId, agentKind: 'codex', agentChatId: conversation.agentChatId,
    agentTurnId: turnId, agentToolCallId: toolCallId, agentSessionTreeId: conversation.agentSessionTreeId,
    conversationId: conversation.conversationId, providerTaskId: conversation.providerTaskId, project: conversation.project,
    activeProvider: conversation.activeProvider, activeProfile: conversation.activeProfile,
  }
}

function parseStoredContext(value: unknown): StoredContext {
  const parsed = JSON.parse(String(value)) as Partial<StoredContext>
  if (!parsed.conversation || !Array.isArray(parsed.turns) || !Array.isArray(parsed.invocations) || !Array.isArray(parsed.providerBindings)) throw new Error('Harness context database row is malformed.')
  return parsed as StoredContext
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }

function canonicalJson(value: unknown) {
  try { return JSON.stringify(value, objectKeySorter) ?? 'null' } catch { return JSON.stringify(String(value)) }
}

function objectKeySorter(_key: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}
