import type { TurnState } from 'tokenless-web-ai-interaction-protocol'

export const WEB_AGENT_PROTOCOL = 'tokenless.web-agent/v1' as const
export const HARNESS_SKILL_MODULE_PROTOCOL = 'tokenless.web-agent.skills/v1' as const
export const HARNESS_SKILL_STATE_PROTOCOL = 'tokenless.web-agent.skills-state/v1' as const
export const HARNESS_RUN_PROTOCOL = 'tokenless.web-agent.run/v1' as const
export const PROVIDER_TURN_PROTOCOL = 'tokenless.provider-turn/v1' as const
export const REQUIRED_HARNESS_PROVIDER_CAPABILITIES = ['conversation.chat', 'file.upload'] as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type SkillSelectionSource = 'explicit_user' | 'caller_agent' | 'web_model'

export type SkillSelection = {
  name: string
  selectedBy: SkillSelectionSource
  expectedSha256?: string | undefined
}

export type HarnessToolDescriptor = {
  name: string
  description: string
  inputSchema: JsonValue
  source: 'filesystem' | 'mcp' | 'local'
}

export type HarnessFinalOutputContract =
  | { kind: 'markdown' }
  | { kind: 'json_schema'; schema: JsonValue }

export type HarnessSkillLimits = {
  maxSkills?: number | undefined
  maxRegistryBytes?: number | undefined
  maxFrontmatterBytes?: number | undefined
  maxSkillFileBytes?: number | undefined
  maxSkillAttachmentsPerTurn?: number | undefined
  maxSkillAttachmentBytesPerTurn?: number | undefined
}

export type PrepareHarnessSkillRunInput = {
  runId: string
  stagingRoot: string
  skillRoot?: string | undefined
  selectedSkills?: readonly SkillSelection[] | undefined
  tools?: readonly HarnessToolDescriptor[] | undefined
  finalOutput?: HarnessFinalOutputContract | undefined
  limits?: HarnessSkillLimits | undefined
}

export type PrepareHarnessBootstrapTurnInput = PrepareHarnessSkillRunInput & {
  taskPrompt: string
  nonce: string
}

export type StartHarnessLocalHttpBootstrapInput = Omit<PrepareHarnessBootstrapTurnInput, 'selectedSkills'> & {
  baseUrl: string
  token: string
  provider: string
  profileId: string
  selectedSkills?: readonly SkillSelection[] | undefined
  requestRef?: string | undefined
}

export type ReadHarnessLocalHttpTurnInput = {
  baseUrl: string
  token: string
  turnRef: string
}

export type ContinueHarnessLocalHttpTurnInput = {
  baseUrl: string
  token: string
  providerBindingRef: string
  providerRef: string
  conversationRef: string
  requestRef: string
  runId: string
  stagingRoot: string
  turn: number
  nonce: string
  resultText: string
  skillLoads?: readonly string[] | undefined
}

export type HarnessLocalHttpContinuationStart = {
  turnState: TurnState
  resultSha256: string
}

export type CompleteHarnessLocalHttpBootstrapInput = ReadHarnessLocalHttpTurnInput & {
  runId: string
  stagingRoot: string
  nonce: string
}

export type CompleteHarnessLocalHttpContinuationInput = ReadHarnessLocalHttpTurnInput & {
  runId: string
  stagingRoot: string
  turn: number
  nonce: string
  resultSha256: string
}

export type HarnessLocalHttpContinuationCompletion = {
  turnState: TurnState
  response: HarnessModelResponse
}

export type HarnessLocalHttpFinalizedBootstrap = {
  protocol: typeof WEB_AGENT_PROTOCOL
  kind: 'bootstrap_turn'
  status: 'finalized'
  runId: string
  turn: 1
  nonce: string
  systemPrompt: Pick<HarnessAttachment, 'kind' | 'name' | 'mediaType' | 'size' | 'sha256'>
  skills: readonly Pick<HarnessAttachment, 'kind' | 'name' | 'mediaType' | 'size' | 'sha256' | 'skillName'>[]
  promptManifest: string
}

export type HarnessLocalHttpBootstrapCompletion = {
  turnState: TurnState
  bootstrap: HarnessLocalHttpFinalizedBootstrap
  response: HarnessModelResponse
}

export type HarnessBootstrapAttachmentAcceptance = {
  name: string
  sha256: string
  accepted: boolean
}

export type FinalizeHarnessBootstrapTurnInput = {
  runId: string
  stagingRoot: string
  nonce: string
  attachmentAcceptances: readonly HarnessBootstrapAttachmentAcceptance[]
}

export type PrepareHarnessSkillTurnInput = {
  runId: string
  stagingRoot: string
  turn: number
  skillLoads?: readonly string[] | undefined
  selectedSkills?: readonly SkillSelection[] | undefined
}

export type ParseHarnessModelResponseInput = {
  runId: string
  stagingRoot: string
  responseText: string
  turn: number
  nonce: string
}

export type SkillDescriptor = {
  name: string
  description: string
}

export type SkillRegistryDiagnosticCode =
  | 'skill_root_missing'
  | 'skill_root_unsafe'
  | 'candidate_not_directory'
  | 'skill_file_missing'
  | 'skill_file_unsafe'
  | 'skill_file_too_large'
  | 'frontmatter_missing'
  | 'frontmatter_too_large'
  | 'frontmatter_invalid'
  | 'name_invalid'
  | 'description_invalid'
  | 'directory_name_mismatch'
  | 'duplicate_name'
  | 'registry_skill_limit'
  | 'registry_byte_limit'

export type SkillRegistryDiagnostic = {
  candidate: string
  code: SkillRegistryDiagnosticCode
  message: string
}

export type SkillRegistryRevision = {
  sha256: string
  skills: readonly SkillDescriptor[]
  diagnostics: readonly SkillRegistryDiagnostic[]
}

export type HarnessAttachment = {
  kind: 'system_prompt' | 'skill'
  name: string
  sourcePath: string
  mediaType: 'text/markdown'
  size: number
  sha256: string
  skillName?: string | undefined
}

export type SkillDeliveryOmissionCode =
  | 'unknown_skill'
  | 'already_loaded'
  | 'duplicate_request'
  | 'invalid_request'
  | 'skill_changed'
  | 'skill_file_unsafe'
  | 'skill_file_too_large'
  | 'expected_revision_mismatch'
  | 'attachment_count_limit'
  | 'attachment_byte_limit'
  | 'attachment_write_failed'
  | 'provider_upload_failed'

export type SkillDeliveryOmission = {
  name: string
  selectedBy: SkillSelectionSource
  code: SkillDeliveryOmissionCode
  message: string
}

export type SkillDeliveryRevision = {
  revision: number
  turn: number
  sha256: string
  attachments: readonly HarnessAttachment[]
  omissions: readonly SkillDeliveryOmission[]
}

export type HarnessSkillRunPreparation = {
  protocol: typeof HARNESS_SKILL_MODULE_PROTOCOL
  runId: string
  runDirectory: string
  requiredProviderCapabilities: typeof REQUIRED_HARNESS_PROVIDER_CAPABILITIES
  registry: SkillRegistryRevision
  systemPrompt: HarnessAttachment
  delivery: SkillDeliveryRevision
  promptManifest: string
}

export type HarnessBootstrapTurnPreparation = {
  protocol: typeof HARNESS_SKILL_MODULE_PROTOCOL
  kind: 'bootstrap_turn_preparation'
  runId: string
  turn: 1
  nonce: string
  requiredProviderCapabilities: typeof REQUIRED_HARNESS_PROVIDER_CAPABILITIES
  attachments: readonly HarnessAttachment[]
  runDirectory: string
  registry: SkillRegistryRevision
  systemPrompt: HarnessAttachment
  candidateDelivery: SkillDeliveryRevision
}

export type HarnessBootstrapTurn = {
  protocol: typeof WEB_AGENT_PROTOCOL
  kind: 'bootstrap_turn'
  runId: string
  turn: 1
  nonce: string
  requiredProviderCapabilities: typeof REQUIRED_HARNESS_PROVIDER_CAPABILITIES
  acceptedAttachments: readonly HarnessAttachment[]
  prompt: string
  runDirectory: string
  registry: SkillRegistryRevision
  systemPrompt: HarnessAttachment
  delivery: SkillDeliveryRevision
  promptManifest: string
}

export type HarnessSkillTurnPreparation = {
  protocol: typeof HARNESS_SKILL_MODULE_PROTOCOL
  runId: string
  runDirectory: string
  delivery: SkillDeliveryRevision
  promptManifest: string
}

export type HarnessToolCall = {
  id: string
  tool: string
  arguments: Record<string, JsonValue>
  dependsOn?: readonly string[] | undefined
}

export type HarnessRunNeed = {
  id: string
  kind: 'user_input'
  prompt: string
  inputSchema: JsonValue
}

export type HarnessActionBatch = {
  protocol: typeof WEB_AGENT_PROTOCOL
  kind: 'action_batch'
  runId: string
  turn: number
  nonce: string
  skillLoads: readonly string[]
  calls: readonly HarnessToolCall[]
  needs: readonly HarnessRunNeed[]
}

export type HarnessFinalResponse = {
  protocol: typeof WEB_AGENT_PROTOCOL
  kind: 'final'
  runId: string
  turn: number
  nonce: string
  output: string
  artifacts: readonly string[]
}

export type HarnessModelResponse = HarnessActionBatch | HarnessFinalResponse

export type AgentMcpServerSpec = {
  name: string
  command: string
  args?: readonly string[] | undefined
  envKeys?: readonly string[] | undefined
  timeoutMs?: number | undefined
  enabledTools?: readonly string[] | undefined
}

export type AgentRunSpec = {
  admissionRef: string
  provider: string
  profileId: string
  taskPrompt: string
  stagingRoot: string
  selectedSkills?: readonly SkillSelection[] | undefined
  finalOutput?: HarnessFinalOutputContract | undefined
  limits?: HarnessSkillLimits | undefined
  maxTurns?: number | undefined
  mcpServers?: readonly AgentMcpServerSpec[] | undefined
}

export type ProviderTurnRequest = {
  protocol: typeof PROVIDER_TURN_PROTOCOL
  requestRef: string
  runId: string
  turn: number
  nonce: string
  provider: string
  profileId: string
  stagingRoot: string
  taskPrompt?: string | undefined
  selectedSkills?: readonly SkillSelection[] | undefined
  tools?: readonly HarnessToolDescriptor[] | undefined
  finalOutput?: HarnessFinalOutputContract | undefined
  limits?: HarnessSkillLimits | undefined
  continuation?: {
    providerRef: string
    providerBindingRef: string
    conversationRef: string
    result: HarnessActionBatchResult
    skillLoads: readonly string[]
  } | undefined
}

export type ProviderTurnState = {
  protocol: typeof PROVIDER_TURN_PROTOCOL
  requestRef: string
  turnRef: string
  providerRef: string
  providerBindingRef: string
  conversationRef: string
  deliverySha256?: string | undefined
  lifecycle: 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'cancelled'
  waitingReason?: string | undefined
  responseText?: string | undefined
  modelResponse?: HarnessModelResponse | undefined
  error?: { code: string; message: string } | undefined
}

export type ProviderTurnClient = {
  /** start and continue must return the original turn when requestRef is replayed. */
  start(request: ProviderTurnRequest): Promise<ProviderTurnState>
  read(request: Pick<ProviderTurnRequest, 'requestRef' | 'runId' | 'turn' | 'nonce' | 'stagingRoot'> & { turnRef: string; expectedDeliverySha256?: string | undefined }): Promise<ProviderTurnState>
  continue(request: ProviderTurnRequest): Promise<ProviderTurnState>
  resume(request: Pick<ProviderTurnRequest, 'requestRef' | 'runId' | 'turn' | 'nonce' | 'stagingRoot'> & { turnRef: string; expectedDeliverySha256?: string | undefined }): Promise<ProviderTurnState>
  cancel(request: { requestRef: string; turnRef?: string | undefined }): Promise<ProviderTurnCancellation>
}

export type ProviderTurnCancellation =
  | { protocol: typeof PROVIDER_TURN_PROTOCOL; requestRef: string; kind: 'cancelled_before_start' }
  | { protocol: typeof PROVIDER_TURN_PROTOCOL; requestRef: string; kind: 'turn'; turn: ProviderTurnState }

export type HarnessToolCallResult = {
  id: string
  status: 'succeeded' | 'failed'
  content: JsonValue
}

export type HarnessNeedResult = {
  id: string
  status: 'answered'
  value: JsonValue
}

export type HarnessActionBatchResult = {
  protocol: typeof WEB_AGENT_PROTOCOL
  kind: 'action_batch_result'
  batchId: string
  callResults: readonly HarnessToolCallResult[]
  needResults: readonly HarnessNeedResult[]
}

export type HarnessToolCatalogEntry = HarnessToolDescriptor & {
  server: string
  serverToolName: string
  readOnly: boolean
  approval: 'allow_read_only' | 'always'
}

export type HarnessToolExecution =
  | { status: 'succeeded' | 'failed'; content: JsonValue }
  | { status: 'authentication_required'; handoff: string }

export type HarnessToolRegistry = {
  catalog(servers: readonly AgentMcpServerSpec[]): Promise<readonly HarnessToolCatalogEntry[]>
  execute(
    entry: HarnessToolCatalogEntry,
    argumentsValue: Record<string, JsonValue>,
    servers: readonly AgentMcpServerSpec[],
  ): Promise<HarnessToolExecution>
}

export type AgentRunStatus =
  | 'discovering_tools'
  | 'submitting_provider'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_authentication'
  | 'waiting_for_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_required'

export type HarnessRunPhase =
  | 'discovering_tools'
  | 'submitting_provider'
  | 'awaiting_provider'
  | 'waiting_intervention'
  | 'executing_batch'
  | 'terminal'
  | 'reconciliation_required'

export type AgentRunView = {
  protocol: typeof HARNESS_RUN_PROTOCOL
  admissionRef: string
  runId: string
  status: AgentRunStatus
  turn: number
  providerTurnRef?: string | undefined
  waiting?: {
    kind: 'approval' | 'authentication' | 'user_input' | 'provider'
    calls?: readonly { id: string; tool: string; arguments: Record<string, JsonValue>; argumentsDigest: string }[] | undefined
    needs?: readonly HarnessRunNeed[] | undefined
    handoff?: string | undefined
  } | undefined
  final?: { output: string; artifacts: readonly string[] } | undefined
  error?: { code: string; message: string } | undefined
}

export type AgentRunIntervention = {
  approvals?: readonly { callId: string; argumentsDigest: string }[] | undefined
  answers?: Readonly<Record<string, JsonValue>> | undefined
  authenticationCompleted?: readonly { callId: string; argumentsDigest: string }[] | undefined
  providerReady?: true | undefined
}

export type WebAgentHarness = {
  start(spec: AgentRunSpec): Promise<AgentRunView>
  read(runId: string): Promise<AgentRunView | null>
  resume(runId: string, intervention: AgentRunIntervention): Promise<AgentRunView>
  cancel(runId: string): Promise<AgentRunView>
  close(): void
}

/** Immutable admission input for one locally durable sequential Harness mission. */
export type EnqueueSequentialHarnessMissionInput = {
  provider: string
  profileId: string
  taskPrompt: string
  finalOutput?: HarnessFinalOutputContract | undefined
  maxTurns?: number | undefined
  cooldownMs?: number | undefined
}

export type OpenSequentialHarnessMissionQueueInput = {
  tokenlessHome: string
  stagingRoot: string
}

export type HarnessMissionStatus = 'queued' | 'preparing' | 'canceled'

/** Redacted admission state. The frozen prompt and profile identity stay private in SQLite. */
export type HarnessMissionView = {
  mode: 'sequential'
  taskRef: string
  status: HarnessMissionStatus
  cancellationRequested: boolean
  promptSha256: string
  createdAt: string
  updatedAt: string
}

export type SequentialHarnessMissionQueue = {
  enqueue(input: EnqueueSequentialHarnessMissionInput): HarnessMissionView
  read(taskRef: string): HarnessMissionView | null
  list(): readonly HarnessMissionView[]
  activateNext(): HarnessMissionView | null
  cancel(taskRef: string): HarnessMissionView | null
  close(): void
}

export class HarnessSkillError extends Error {
  readonly code: string
  readonly context: Readonly<Record<string, JsonValue>> | undefined

  constructor(code: string, message: string, context?: Readonly<Record<string, JsonValue>>) {
    super(message)
    this.name = 'HarnessSkillError'
    this.code = code
    this.context = context
  }
}

export class ProviderTurnDispatchError extends Error {
  constructor(
    readonly dispatch: 'deterministic' | 'ambiguous',
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderTurnDispatchError'
  }
}
