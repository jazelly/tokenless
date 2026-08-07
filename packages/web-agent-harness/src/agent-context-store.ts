import { createHash, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
  AGENT_CONTEXT_PROTOCOL,
  type AgentConversationContext,
  type AgentInvocationContext,
  type CodexAppServerThread,
  type CodexContextInspection,
} from './agent-contracts.js'

const DATABASE_FILE = 'harness.sqlite3'

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
    store.initialize()
    return store
  }

  private constructor(homeDir: string) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE)
    this.#db = new DatabaseSync(this.databasePath)
    this.#db.exec('PRAGMA foreign_keys = ON;')
    this.#db.exec('PRAGMA busy_timeout = 3000;')
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  observeCodexSession({
    chatId,
    cwd,
    model,
    appServerThread,
  }: {
    chatId: string
    cwd: string
    model?: string | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }) {
    const project = resolveProject(cwd)
    const conversation = conversationIdentity(chatId, project)
    const now = new Date().toISOString()
    this.transaction(() => {
      this.run(
        `INSERT INTO harness_projects (
          project_id, canonical_root, provider_project_name, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          canonical_root = excluded.canonical_root,
          provider_project_name = excluded.provider_project_name,
          last_seen_at = excluded.last_seen_at`,
        project.projectId,
        project.canonicalRoot,
        project.providerProjectName,
        now,
        now,
      )
      this.run(
        `INSERT INTO harness_agent_conversations (
          agent_kind, agent_chat_id, conversation_id, project_id, provider_task_id,
          agent_session_tree_id, parent_chat_id, forked_from_chat_id, model,
          app_server_status, first_seen_at, last_seen_at
        ) VALUES ('codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_kind, agent_chat_id) DO UPDATE SET
          project_id = excluded.project_id,
          agent_session_tree_id = COALESCE(excluded.agent_session_tree_id, harness_agent_conversations.agent_session_tree_id),
          parent_chat_id = COALESCE(excluded.parent_chat_id, harness_agent_conversations.parent_chat_id),
          forked_from_chat_id = COALESCE(excluded.forked_from_chat_id, harness_agent_conversations.forked_from_chat_id),
          model = COALESCE(excluded.model, harness_agent_conversations.model),
          app_server_status = CASE
            WHEN excluded.app_server_status = 'resolved' THEN 'resolved'
            ELSE harness_agent_conversations.app_server_status
          END,
          last_seen_at = excluded.last_seen_at`,
        chatId,
        conversation.conversationId,
        project.projectId,
        conversation.providerTaskId,
        appServerThread?.sessionId ?? null,
        appServerThread?.parentThreadId ?? null,
        appServerThread?.forkedFromId ?? null,
        normalizeOptional(model),
        appServerThread ? 'resolved' : 'not_resolved',
        now,
        now,
      )
    })
    return this.conversation(chatId)
  }

  observeCodexTurn({
    chatId,
    turnId,
    cwd,
    model,
    prompt,
  }: {
    chatId: string
    turnId: string
    cwd: string
    model?: string | undefined
    prompt?: string | undefined
  }) {
    this.observeCodexSession({ chatId, cwd, model })
    const now = new Date().toISOString()
    this.run(
      `INSERT INTO harness_agent_turns (
        agent_kind, agent_chat_id, agent_turn_id, prompt_sha256, started_at, last_seen_at, completed_at
      ) VALUES ('codex', ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(agent_kind, agent_chat_id, agent_turn_id) DO UPDATE SET
        prompt_sha256 = COALESCE(excluded.prompt_sha256, harness_agent_turns.prompt_sha256),
        last_seen_at = excluded.last_seen_at`,
      chatId,
      turnId,
      prompt === undefined ? null : sha256(prompt),
      now,
      now,
    )
  }

  completeCodexTurn(chatId: string, turnId: string) {
    const now = new Date().toISOString()
    this.run(
      `UPDATE harness_agent_turns
       SET completed_at = COALESCE(completed_at, ?), last_seen_at = ?
       WHERE agent_kind = 'codex' AND agent_chat_id = ? AND agent_turn_id = ?`,
      now,
      now,
      chatId,
      turnId,
    )
  }

  createCodexInvocation({
    chatId,
    turnId,
    toolCallId,
    toolName,
    toolInput,
    cwd,
    model,
    appServerThread,
  }: {
    chatId: string
    turnId: string
    toolCallId: string
    toolName: string
    toolInput: unknown
    cwd: string
    model?: string | undefined
    appServerThread?: CodexAppServerThread | null | undefined
  }): AgentInvocationContext {
    const conversation = this.observeCodexSession({ chatId, cwd, model, appServerThread })
    this.observeCodexTurn({ chatId, turnId, cwd, model })
    const existing = this.get(
      `SELECT binding_id
       FROM harness_tool_invocations
       WHERE agent_kind = 'codex' AND agent_chat_id = ? AND agent_tool_call_id = ?`,
      chatId,
      toolCallId,
    )
    const bindingId = existing ? String(existing.binding_id) : `binding_${randomUUID()}`
    const now = new Date().toISOString()
    this.run(
      `INSERT INTO harness_tool_invocations (
        binding_id, agent_kind, agent_chat_id, agent_turn_id, agent_tool_call_id,
        tool_name, tool_input_sha256, status, provider, profile, job_id,
        provider_task_id, created_at, updated_at
      ) VALUES (?, 'codex', ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(agent_kind, agent_chat_id, agent_tool_call_id) DO UPDATE SET
        agent_turn_id = excluded.agent_turn_id,
        tool_name = excluded.tool_name,
        tool_input_sha256 = excluded.tool_input_sha256,
        updated_at = excluded.updated_at`,
      bindingId,
      chatId,
      turnId,
      toolCallId,
      toolName,
      sha256(canonicalJson(toolInput)),
      conversation.providerTaskId,
      now,
      now,
    )
    return {
      protocol: AGENT_CONTEXT_PROTOCOL,
      bindingId,
      agentKind: 'codex',
      agentChatId: chatId,
      agentTurnId: turnId,
      agentToolCallId: toolCallId,
      agentSessionTreeId: conversation.agentSessionTreeId,
      conversationId: conversation.conversationId,
      providerTaskId: conversation.providerTaskId,
      project: conversation.project,
      activeProvider: conversation.activeProvider,
      activeProfile: conversation.activeProfile,
    }
  }

  completeCodexInvocation({
    chatId,
    toolCallId,
    outcome,
  }: {
    chatId: string
    toolCallId: string
    outcome: {
      ok: boolean | null
      provider: string | null
      profile: string | null
      jobId: string | null
      taskId: string | null
      providerProjectId: string | null
      providerConversationRef: string | null
    }
  }) {
    const row = this.get(
      `SELECT i.binding_id, c.conversation_id, i.provider_task_id
       FROM harness_tool_invocations i
       JOIN harness_agent_conversations c
         ON c.agent_kind = i.agent_kind AND c.agent_chat_id = i.agent_chat_id
       WHERE i.agent_kind = 'codex' AND i.agent_chat_id = ? AND i.agent_tool_call_id = ?`,
      chatId,
      toolCallId,
    )
    if (!row) return
    const providerTaskId = String(row.provider_task_id)
    if (outcome.taskId && outcome.taskId !== providerTaskId) return
    const now = new Date().toISOString()
    this.transaction(() => {
      this.run(
        `UPDATE harness_tool_invocations
         SET status = ?, provider = ?, profile = ?, job_id = ?, updated_at = ?
         WHERE binding_id = ?`,
        outcome.ok === true ? 'succeeded' : outcome.ok === false ? 'failed' : 'completed',
        outcome.provider,
        outcome.profile,
        outcome.jobId,
        now,
        String(row.binding_id),
      )
      if (outcome.provider) {
        this.run(
          `INSERT INTO harness_provider_bindings (
            conversation_id, provider, profile, provider_task_id, last_job_id,
            provider_project_id, provider_conversation_ref, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, provider, profile) DO UPDATE SET
            provider_task_id = excluded.provider_task_id,
            last_job_id = COALESCE(excluded.last_job_id, harness_provider_bindings.last_job_id),
            provider_project_id = COALESCE(excluded.provider_project_id, harness_provider_bindings.provider_project_id),
            provider_conversation_ref = COALESCE(excluded.provider_conversation_ref, harness_provider_bindings.provider_conversation_ref),
            last_seen_at = excluded.last_seen_at`,
          String(row.conversation_id),
          outcome.provider,
          outcome.profile ?? '',
          providerTaskId,
          outcome.jobId,
          outcome.providerProjectId,
          outcome.providerConversationRef,
          now,
          now,
        )
        this.run(
          `UPDATE harness_agent_conversations
           SET active_provider = ?, active_profile = ?, last_seen_at = ?
           WHERE agent_kind = 'codex' AND agent_chat_id = ?`,
          outcome.provider,
          outcome.profile,
          now,
          chatId,
        )
      }
    })
  }

  conversation(chatId: string): AgentConversationContext {
    const row = this.get(
      `SELECT c.*, p.canonical_root, p.provider_project_name
       FROM harness_agent_conversations c
       JOIN harness_projects p ON p.project_id = c.project_id
       WHERE c.agent_kind = 'codex' AND c.agent_chat_id = ?`,
      chatId,
    )
    if (!row) throw new Error(`Codex conversation is not registered: ${chatId}`)
    return rowToConversation(row)
  }

  inspectCodexConversation(chatId: string): CodexContextInspection {
    const conversation = this.conversation(chatId)
    const turns = this.all(
      `SELECT agent_turn_id, prompt_sha256, started_at, completed_at
       FROM harness_agent_turns
       WHERE agent_kind = 'codex' AND agent_chat_id = ?
       ORDER BY started_at ASC, agent_turn_id ASC`,
      chatId,
    ).map((row) => ({
      turnId: String(row.agent_turn_id),
      promptSha256: nullableString(row.prompt_sha256),
      startedAt: String(row.started_at),
      completedAt: nullableString(row.completed_at),
    }))
    const invocations = this.all(
      `SELECT binding_id, agent_turn_id, agent_tool_call_id, tool_name, status,
              provider, profile, job_id, provider_task_id, created_at, updated_at
       FROM harness_tool_invocations
       WHERE agent_kind = 'codex' AND agent_chat_id = ?
       ORDER BY created_at ASC, binding_id ASC`,
      chatId,
    ).map((row) => ({
      bindingId: String(row.binding_id),
      turnId: String(row.agent_turn_id),
      toolCallId: String(row.agent_tool_call_id),
      toolName: String(row.tool_name),
      status: String(row.status),
      provider: nullableString(row.provider),
      profile: nullableString(row.profile),
      jobId: nullableString(row.job_id),
      providerTaskId: String(row.provider_task_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
    const providerBindings = this.all(
      `SELECT provider, profile, provider_task_id, provider_project_id,
              provider_conversation_ref, last_job_id, first_seen_at, last_seen_at
       FROM harness_provider_bindings
       WHERE conversation_id = ?
       ORDER BY last_seen_at ASC, provider ASC, profile ASC`,
      conversation.conversationId,
    ).map((row) => ({
      provider: String(row.provider),
      profile: nullableString(row.profile),
      providerTaskId: String(row.provider_task_id),
      providerProjectId: nullableString(row.provider_project_id),
      providerConversationRef: nullableString(row.provider_conversation_ref),
      lastJobId: nullableString(row.last_job_id),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
    }))
    return { protocol: AGENT_CONTEXT_PROTOCOL, conversation, turns, invocations, providerBindings }
  }

  counts() {
    return {
      projects: this.count('harness_projects'),
      conversations: this.count('harness_agent_conversations'),
      turns: this.count('harness_agent_turns'),
      invocations: this.count('harness_tool_invocations'),
    }
  }

  private count(table: string) {
    const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>
    return Number(row.count)
  }

  private initialize() {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS harness_projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        canonical_root TEXT NOT NULL UNIQUE,
        provider_project_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_agent_conversations (
        agent_kind TEXT NOT NULL,
        agent_chat_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES harness_projects(project_id),
        provider_task_id TEXT NOT NULL UNIQUE,
        agent_session_tree_id TEXT,
        parent_chat_id TEXT,
        forked_from_chat_id TEXT,
        model TEXT,
        app_server_status TEXT NOT NULL,
        active_provider TEXT,
        active_profile TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (agent_kind, agent_chat_id)
      );
      CREATE TABLE IF NOT EXISTS harness_agent_turns (
        agent_kind TEXT NOT NULL,
        agent_chat_id TEXT NOT NULL,
        agent_turn_id TEXT NOT NULL,
        prompt_sha256 TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (agent_kind, agent_chat_id, agent_turn_id),
        FOREIGN KEY (agent_kind, agent_chat_id)
          REFERENCES harness_agent_conversations(agent_kind, agent_chat_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS harness_tool_invocations (
        binding_id TEXT PRIMARY KEY NOT NULL,
        agent_kind TEXT NOT NULL,
        agent_chat_id TEXT NOT NULL,
        agent_turn_id TEXT NOT NULL,
        agent_tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT,
        profile TEXT,
        job_id TEXT,
        provider_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_kind, agent_chat_id, agent_tool_call_id),
        FOREIGN KEY (agent_kind, agent_chat_id, agent_turn_id)
          REFERENCES harness_agent_turns(agent_kind, agent_chat_id, agent_turn_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS harness_provider_bindings (
        conversation_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile TEXT NOT NULL,
        provider_task_id TEXT NOT NULL,
        last_job_id TEXT,
        provider_project_id TEXT,
        provider_conversation_ref TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, provider, profile),
        FOREIGN KEY (conversation_id)
          REFERENCES harness_agent_conversations(conversation_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS harness_turns_chat_idx
        ON harness_agent_turns(agent_kind, agent_chat_id, started_at);
      CREATE INDEX IF NOT EXISTS harness_invocations_chat_idx
        ON harness_tool_invocations(agent_kind, agent_chat_id, created_at);
    `)
    this.ensureColumn('harness_provider_bindings', 'provider_project_id', 'TEXT')
    this.ensureColumn('harness_provider_bindings', 'provider_conversation_ref', 'TEXT')
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

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]
    if (columns.some((entry) => entry.name === column)) return
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private run(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).run(...parameters)
  }

  private get(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).get(...parameters) as Record<string, unknown> | undefined
  }

  private all(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).all(...parameters) as Record<string, unknown>[]
  }
}

function resolveProject(cwd: string) {
  let canonicalRoot = fsSync.realpathSync(path.resolve(cwd))
  let cursor = canonicalRoot
  while (true) {
    if (fsSync.existsSync(path.join(cursor, '.git'))) {
      canonicalRoot = cursor
      break
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const digest = sha256(canonicalRoot)
  const projectId = `project_${digest.slice(0, 24)}`
  const basename = path.basename(canonicalRoot) || 'project'
  return {
    projectId,
    canonicalRoot,
    providerProjectName: `${basename}-${digest.slice(0, 8)}`,
  }
}

function conversationIdentity(chatId: string, project: ReturnType<typeof resolveProject>) {
  const digest = sha256(`codex\0${chatId}`)
  return {
    conversationId: `conversation_${digest.slice(0, 24)}`,
    providerTaskId: `agent:codex:${digest.slice(0, 40)}`,
    project,
  }
}

function rowToConversation(row: Record<string, unknown>): AgentConversationContext {
  return {
    conversationId: String(row.conversation_id),
    agentKind: 'codex',
    agentChatId: String(row.agent_chat_id),
    agentSessionTreeId: nullableString(row.agent_session_tree_id),
    parentChatId: nullableString(row.parent_chat_id),
    forkedFromChatId: nullableString(row.forked_from_chat_id),
    providerTaskId: String(row.provider_task_id),
    project: {
      projectId: String(row.project_id),
      canonicalRoot: String(row.canonical_root),
      providerProjectName: String(row.provider_project_name),
    },
    activeProvider: nullableString(row.active_provider),
    activeProfile: nullableString(row.active_profile),
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown) {
  try {
    return JSON.stringify(value, objectKeySorter) ?? 'null'
  } catch {
    return JSON.stringify(String(value))
  }
}

function objectKeySorter(_key: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeOptional(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value ? value : null
}
