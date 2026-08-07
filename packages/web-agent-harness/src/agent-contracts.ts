export const AGENT_CONTEXT_PROTOCOL = 'tokenless.agent-context/v1' as const
export const CODEX_HOOK_PROTOCOL = 'tokenless.codex-hook/v1' as const

export type AgentKind = 'codex'

export type AgentProjectContext = {
  projectId: string
  canonicalRoot: string
  providerProjectName: string
}

export type AgentConversationContext = {
  conversationId: string
  agentKind: AgentKind
  agentChatId: string
  agentSessionTreeId: string | null
  parentChatId: string | null
  forkedFromChatId: string | null
  providerTaskId: string
  project: AgentProjectContext
  activeProvider: string | null
  activeProfile: string | null
}

export type AgentInvocationContext = {
  protocol: typeof AGENT_CONTEXT_PROTOCOL
  bindingId: string
  agentKind: AgentKind
  agentChatId: string
  agentTurnId: string
  agentToolCallId: string
  agentSessionTreeId: string | null
  conversationId: string
  providerTaskId: string
  project: AgentProjectContext
  activeProvider: string | null
  activeProfile: string | null
}

export type AgentInvocationOutcome = {
  ok: boolean | null
  provider: string | null
  profile: string | null
  jobId: string | null
  taskId: string | null
  providerProjectId: string | null
  providerConversationRef: string | null
}

export type CodexAppServerThread = {
  id: string
  sessionId: string
  parentThreadId: string | null
  forkedFromId: string | null
  cwd: string
  source: unknown
  gitInfo: unknown
}

export type CodexHookInput = {
  session_id: string
  transcript_path?: string | null | undefined
  cwd: string
  hook_event_name: string
  model?: string | undefined
  permission_mode?: string | undefined
  turn_id?: string | undefined
  source?: string | undefined
  reason?: string | undefined
  prompt?: string | undefined
  tool_name?: string | undefined
  tool_use_id?: string | undefined
  tool_input?: unknown
  tool_response?: unknown
  last_assistant_message?: string | null | undefined
}

export type CodexHookResult = Record<string, unknown>

export type CodexIntegrationCommand = {
  executable: string
  script: string
}

export type CodexIntegrationInput = {
  codexHome: string
  tokenlessHome: string
  command: CodexIntegrationCommand
}

export type CodexIntegrationStatus = {
  protocol: typeof CODEX_HOOK_PROTOCOL
  agent: 'codex'
  codexHome: string
  tokenlessHome: string
  guidance: {
    installed: boolean
    path: string
    usesOverride: boolean
  }
  hooks: {
    installed: boolean
    path: string
    events: readonly string[]
    trustRequired: boolean
  }
  context: {
    databasePath: string
    projects: number
    conversations: number
    turns: number
    invocations: number
  }
}

export type CodexContextInspection = {
  protocol: typeof AGENT_CONTEXT_PROTOCOL
  conversation: AgentConversationContext
  turns: readonly {
    turnId: string
    promptSha256: string | null
    startedAt: string
    completedAt: string | null
  }[]
  invocations: readonly {
    bindingId: string
    turnId: string
    toolCallId: string
    toolName: string
    status: string
    provider: string | null
    profile: string | null
    jobId: string | null
    providerTaskId: string
    createdAt: string
    updatedAt: string
  }[]
  providerBindings: readonly {
    provider: string
    profile: string | null
    providerTaskId: string
    providerProjectId: string | null
    providerConversationRef: string | null
    lastJobId: string | null
    firstSeenAt: string
    lastSeenAt: string
  }[]
}
