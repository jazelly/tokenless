import { isProviderIdSyntax } from './provider-identity.js'
import type { ProviderId } from './provider-identity.js'

export const TASK_CAPABILITY_CATALOG_SCHEMA_ID = 'tokenless.task-capability-catalog.v2'
export const TASK_CAPABILITY_ROUTE_SCHEMA_ID = 'tokenless.task-capability-route.v1'

export const TASK_CAPABILITIES = Object.freeze({
  CONVERSATION_CHAT: 'conversation.chat',
  CONVERSATION_CONTINUE: 'conversation.continue',
  MODEL_COMPARE: 'model.compare',
  AGENT_EXECUTE: 'agent.execute',
  FILE_UPLOAD: 'file.upload',
  IMAGE_INPUT: 'image.input',
  AUDIO_INPUT: 'audio.input',
  AUDIO_TRANSCRIPTION: 'audio.transcription',
  VIDEO_INPUT: 'video.input',
  URL_INPUT: 'url.input',
  REPOSITORY_IMPORT: 'repository.import',
  SEARCH_WEB: 'search.web',
  RESEARCH_DEEP: 'research.deep',
  REASONING_EXTENDED: 'reasoning.extended',
  CODE_EXECUTE: 'code.execute',
  DATA_ANALYZE: 'data.analyze',
  IMAGE_GENERATION: 'image.generation',
  IMAGE_EDIT: 'image.edit',
  VIDEO_GENERATION: 'video.generation',
  AUDIO_GENERATION: 'audio.generation',
  DOCUMENT_GENERATION: 'document.generation',
  PRESENTATION_GENERATION: 'presentation.generation',
  SPREADSHEET_GENERATION: 'spreadsheet.generation',
  WEBSITE_GENERATION: 'website.generation',
  WORKSPACE_NATIVE: 'workspace.native',
  WORKSPACE_INSTRUCTIONS: 'workspace.instructions',
  WORKSPACE_KNOWLEDGE: 'workspace.knowledge',
  SOURCE_CONNECTED: 'source.connected',
  RESPONSE_CITATIONS: 'response.citations',
  ARTIFACT_DOWNLOAD: 'artifact.download',
  TASK_BACKGROUND: 'task.background',
  TASK_INTERACTIVE: 'task.interactive',
  TASK_PARALLEL: 'task.parallel',
})

export type TaskCapabilityId = typeof TASK_CAPABILITIES[keyof typeof TASK_CAPABILITIES]
export type TaskCapabilityFamily =
  | 'conversation'
  | 'input'
  | 'retrieval_reasoning'
  | 'media_generation'
  | 'artifact_generation'
  | 'workspace_knowledge'
  | 'evidence_lifecycle'
export type TaskCapabilityLifecycle = 'immediate' | 'interactive' | 'long_running'
export type TaskCapabilityStability = 'candidate' | 'experimental' | 'supported'
export type TaskCapabilitySideEffect =
  | 'read_provider_state'
  | 'upload_content'
  | 'submit_prompt'
  | 'create_provider_resource'
  | 'persist_provider_state'
  | 'share_external_reference'
  | 'generate_artifact'
export type TaskCapabilityOutputKind =
  | 'text'
  | 'citation'
  | 'file'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'website'

export type JsonSchema = Readonly<Record<string, unknown>>

export type TaskCapabilityDefinition = Readonly<{
  id: TaskCapabilityId
  title: string
  description: string
  family: TaskCapabilityFamily
  parametersSchema: JsonSchema
  lifecycle: TaskCapabilityLifecycle
  sideEffects: readonly TaskCapabilitySideEffect[]
  implies: readonly TaskCapabilityId[]
  composesWith: readonly TaskCapabilityId[]
  conflictsWith: readonly TaskCapabilityId[]
  requiredEvidence: readonly string[]
  outputKinds: readonly TaskCapabilityOutputKind[]
  stability: TaskCapabilityStability
}>

export type ProviderTaskCapabilityRoute = Readonly<{
  provider: ProviderId
  capability: TaskCapabilityId
  support: 'experimental' | 'supported'
  strategy: string
  evidence: readonly string[]
}>

export type TaskCapabilityRouteCandidate = Readonly<{
  provider: ProviderId
  runtimeEligibility: 'eligible' | 'ineligible' | 'unchecked'
  reason?: string | null
  preferenceRank?: number
}>

export type TaskCapabilityRouteEvaluation = Readonly<{
  provider: ProviderId
  runtimeEligibility: TaskCapabilityRouteCandidate['runtimeEligibility']
  compatible: boolean
  missingCapabilities: readonly TaskCapabilityId[]
  support: 'experimental' | 'supported' | null
  rank: number | null
  score: Readonly<{
    runtimeEligibility: number
    evidenceMaturity: number
    providerPreference: number
  }> | null
  reason: string | null
}>

export type TaskCapabilityRoute = Readonly<{
  schema: typeof TASK_CAPABILITY_ROUTE_SCHEMA_ID
  provider: ProviderId
  requirements: readonly TaskCapabilityId[]
  strategies: readonly string[]
  support: 'experimental' | 'supported'
  evidence: readonly string[]
  runtimeEligibility: TaskCapabilityRouteCandidate['runtimeEligibility']
}>

export type TaskCapabilityRouteFailure = Readonly<{
  ok: false
  code: 'task_capability_route_unavailable'
  message: string
  requirements: readonly TaskCapabilityId[]
  evaluated: readonly TaskCapabilityRouteEvaluation[]
}>

export type TaskCapabilityRouteDecision =
  | Readonly<{
      ok: true
      route: TaskCapabilityRoute
      evaluated: readonly TaskCapabilityRouteEvaluation[]
    }>
  | TaskCapabilityRouteFailure

export type TaskCapabilityRoutesDecision =
  | Readonly<{
      ok: true
      routes: readonly TaskCapabilityRoute[]
      evaluated: readonly TaskCapabilityRouteEvaluation[]
    }>
  | TaskCapabilityRouteFailure

export class TaskCapabilityRequestError extends Error {
  readonly code: 'invalid_task_capability'
  readonly capability: string

  constructor(capability: string) {
    super(`Unknown task capability: ${capability}`)
    this.name = 'TaskCapabilityRequestError'
    this.code = 'invalid_task_capability'
    this.capability = capability
  }
}

const EMPTY_PARAMETERS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({}),
})

const TASK_CAPABILITY_CATALOG = Object.freeze([
  defineCapability({
    id: TASK_CAPABILITIES.CONVERSATION_CHAT,
    title: 'Chat',
    description: 'Submit a prompt and read the correlated visible provider response.',
    family: 'conversation',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt', 'persist_provider_state'],
    requiredEvidence: ['visible_submission', 'correlated_visible_response', 'durable_job'],
    outputKinds: ['text'],
    stability: 'supported',
  }),
  defineCapability({
    id: TASK_CAPABILITIES.CONVERSATION_CONTINUE,
    title: 'Continue conversation',
    description: 'Continue the exact durable provider conversation selected by Tokenless.',
    family: 'conversation',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.CONVERSATION_CHAT],
    requiredEvidence: ['exact_conversation_identity', 'visible_two_turns', 'durable_mapping'],
    outputKinds: ['text'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.MODEL_COMPARE,
    title: 'Compare models',
    description: 'Return two complete visible model answers for one prompt without silently dropping either.',
    family: 'retrieval_reasoning',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.CONVERSATION_CHAT],
    requiredEvidence: ['visible_two_model_answers', 'complete_alternative_outputs'],
    outputKinds: ['text'],
    stability: 'supported',
  }),
  defineCapability({
    id: TASK_CAPABILITIES.AGENT_EXECUTE,
    title: 'Agent execution',
    description: 'Run a provider-native agent through visible tool steps to one terminal result.',
    family: 'retrieval_reasoning',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.SEARCH_WEB, TASK_CAPABILITIES.RESPONSE_CITATIONS],
    requiredEvidence: ['visible_tool_steps', 'terminal_agent_result', 'correlated_visible_response'],
    outputKinds: ['text', 'citation'],
    stability: 'experimental',
  }),
  defineCapability({
    id: TASK_CAPABILITIES.FILE_UPLOAD,
    title: 'Upload file',
    description: 'Attach caller-selected files and prove visible provider acceptance.',
    family: 'input',
    lifecycle: 'immediate',
    sideEffects: ['upload_content'],
    requiredEvidence: ['visible_provider_attachment'],
    outputKinds: [],
    stability: 'supported',
  }),
  inputCapability(TASK_CAPABILITIES.IMAGE_INPUT, 'Image input', 'Deliver an image as provider input.'),
  inputCapability(TASK_CAPABILITIES.AUDIO_INPUT, 'Audio input', 'Deliver audio as provider input.'),
  defineCapability({
    id: TASK_CAPABILITIES.AUDIO_TRANSCRIPTION,
    title: 'Audio transcription',
    description: 'Produce a completed visible transcript correlated to caller-selected audio.',
    family: 'retrieval_reasoning',
    lifecycle: 'interactive',
    sideEffects: ['upload_content', 'submit_prompt', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.AUDIO_INPUT],
    requiredEvidence: ['source_audio_correlation', 'completed_visible_transcript'],
    outputKinds: ['text'],
  }),
  inputCapability(TASK_CAPABILITIES.VIDEO_INPUT, 'Video input', 'Deliver video as provider input.'),
  defineCapability({
    id: TASK_CAPABILITIES.URL_INPUT,
    title: 'URL input',
    description: 'Deliver a caller-authorized URL as provider input.',
    family: 'input',
    parametersSchema: objectParameters({
      url: { type: 'string', format: 'uri', maxLength: 2048 },
    }, ['url']),
    lifecycle: 'immediate',
    sideEffects: ['share_external_reference'],
    requiredEvidence: ['visible_provider_url_acceptance'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.REPOSITORY_IMPORT,
    title: 'Repository import',
    description: 'Import an authorized repository through a native provider flow.',
    family: 'input',
    parametersSchema: objectParameters({
      repository: { type: 'string', minLength: 1, maxLength: 2048 },
      revision: { type: 'string', minLength: 1, maxLength: 240 },
    }, ['repository']),
    lifecycle: 'interactive',
    sideEffects: ['read_provider_state', 'persist_provider_state', 'share_external_reference'],
    requiredEvidence: ['authorized_repository_identity', 'visible_provider_import'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.SEARCH_WEB,
    title: 'Web search',
    description: 'Use a provider-native web retrieval strategy and return grounded results.',
    family: 'retrieval_reasoning',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt'],
    requiredEvidence: ['visible_search_strategy', 'grounded_visible_response'],
    outputKinds: ['text', 'citation'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.RESEARCH_DEEP,
    title: 'Deep research',
    description: 'Complete a provider-native research lifecycle through final cited report delivery.',
    family: 'retrieval_reasoning',
    parametersSchema: objectParameters({
      clarificationPolicy: enumProperty(['wait_for_user', 'include_everything']),
      sourceScope: { type: 'string', maxLength: 4000 },
    }),
    lifecycle: 'long_running',
    sideEffects: ['submit_prompt', 'persist_provider_state', 'generate_artifact'],
    implies: [
      TASK_CAPABILITIES.SEARCH_WEB,
      TASK_CAPABILITIES.RESPONSE_CITATIONS,
      TASK_CAPABILITIES.TASK_BACKGROUND,
      TASK_CAPABILITIES.TASK_INTERACTIVE,
    ],
    requiredEvidence: ['research_plan', 'terminal_report', 'visible_citations', 'durable_background_job'],
    outputKinds: ['text', 'citation', 'document'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.REASONING_EXTENDED,
    title: 'Extended reasoning',
    description: 'Use a proven provider reasoning strategy rather than a raw provider mode label.',
    family: 'retrieval_reasoning',
    parametersSchema: objectParameters({
      intensity: enumProperty(['balanced', 'high', 'maximum']),
    }),
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt'],
    requiredEvidence: ['selected_reasoning_strategy', 'correlated_visible_response'],
    outputKinds: ['text'],
  }),
  reasoningCapability(TASK_CAPABILITIES.CODE_EXECUTE, 'Code execution', 'Execute code in a provider-owned visible environment.'),
  reasoningCapability(TASK_CAPABILITIES.DATA_ANALYZE, 'Data analysis', 'Analyze structured data through a provider-native workflow.'),
  generationCapability(TASK_CAPABILITIES.IMAGE_GENERATION, 'Image generation', 'image', 'image'),
  defineCapability({
    id: TASK_CAPABILITIES.IMAGE_EDIT,
    title: 'Image editing',
    description: 'Produce a completed edited image correlated to the submitted source image and instruction.',
    family: 'media_generation',
    parametersSchema: objectParameters({
      format: { type: 'string', minLength: 1, maxLength: 40 },
    }),
    lifecycle: 'interactive',
    sideEffects: ['upload_content', 'submit_prompt', 'generate_artifact', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.IMAGE_INPUT],
    requiredEvidence: ['source_image_correlation', 'completed_visible_artifact', 'bounded_artifact_reference'],
    outputKinds: ['image'],
  }),
  generationCapability(TASK_CAPABILITIES.VIDEO_GENERATION, 'Video generation', 'video', 'video', 'long_running'),
  generationCapability(TASK_CAPABILITIES.AUDIO_GENERATION, 'Audio generation', 'audio', 'audio', 'long_running'),
  generationCapability(TASK_CAPABILITIES.DOCUMENT_GENERATION, 'Document generation', 'document', 'document', 'long_running'),
  generationCapability(TASK_CAPABILITIES.PRESENTATION_GENERATION, 'Presentation generation', 'presentation', 'presentation', 'long_running'),
  generationCapability(TASK_CAPABILITIES.SPREADSHEET_GENERATION, 'Spreadsheet generation', 'spreadsheet', 'spreadsheet', 'long_running'),
  generationCapability(TASK_CAPABILITIES.WEBSITE_GENERATION, 'Website generation', 'website', 'website', 'long_running'),
  defineCapability({
    id: TASK_CAPABILITIES.WORKSPACE_NATIVE,
    title: 'Native workspace',
    description: 'Create or reuse an exact native provider Project or equivalent workspace.',
    family: 'workspace_knowledge',
    parametersSchema: objectParameters({
      name: { type: 'string', minLength: 1, maxLength: 240 },
    }, ['name']),
    lifecycle: 'interactive',
    sideEffects: ['create_provider_resource', 'persist_provider_state'],
    requiredEvidence: ['exact_workspace_identity', 'created_or_reused', 'durable_mapping'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.WORKSPACE_INSTRUCTIONS,
    title: 'Workspace instructions',
    description: 'Apply instructions through a native provider workspace and prove their visible effect.',
    family: 'workspace_knowledge',
    parametersSchema: objectParameters({
      instructions: { type: 'string', minLength: 1, maxLength: 32768 },
    }, ['instructions']),
    lifecycle: 'interactive',
    sideEffects: ['create_provider_resource', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.WORKSPACE_NATIVE],
    requiredEvidence: ['visible_instruction_application'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.WORKSPACE_KNOWLEDGE,
    title: 'Workspace knowledge',
    description: 'Persist authorized knowledge in an exact native provider workspace.',
    family: 'workspace_knowledge',
    lifecycle: 'interactive',
    sideEffects: ['upload_content', 'persist_provider_state'],
    implies: [TASK_CAPABILITIES.WORKSPACE_NATIVE],
    requiredEvidence: ['visible_workspace_knowledge', 'durable_mapping'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.SOURCE_CONNECTED,
    title: 'Connected source',
    description: 'Read from an explicitly authorized provider connector or connected source.',
    family: 'workspace_knowledge',
    parametersSchema: objectParameters({
      source: { type: 'string', minLength: 1, maxLength: 120 },
    }, ['source']),
    lifecycle: 'interactive',
    sideEffects: ['read_provider_state'],
    requiredEvidence: ['authorized_source_identity', 'visible_source_use'],
    outputKinds: ['text', 'citation'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.RESPONSE_CITATIONS,
    title: 'Response citations',
    description: 'Require normalized citations backed by links visible in the provider response.',
    family: 'evidence_lifecycle',
    lifecycle: 'interactive',
    sideEffects: [],
    requiredEvidence: ['normalized_citation', 'visible_source_link'],
    outputKinds: ['citation'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
    title: 'Downloadable artifact',
    description: 'Require a completed provider artifact that can be downloaded.',
    family: 'evidence_lifecycle',
    lifecycle: 'long_running',
    sideEffects: [],
    requiredEvidence: ['completed_artifact', 'download_reference'],
    outputKinds: ['file'],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.TASK_BACKGROUND,
    title: 'Background task',
    description: 'Allow a durable provider task to continue without keeping the page foregrounded.',
    family: 'evidence_lifecycle',
    lifecycle: 'long_running',
    sideEffects: ['persist_provider_state'],
    requiredEvidence: ['durable_background_job', 'terminal_state'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.TASK_INTERACTIVE,
    title: 'Interactive task',
    description: 'Surface provider clarification or confirmation as a resumable waiting-for-user state.',
    family: 'evidence_lifecycle',
    lifecycle: 'interactive',
    sideEffects: ['persist_provider_state'],
    requiredEvidence: ['waiting_for_user', 'same_job_resume'],
    outputKinds: [],
  }),
  defineCapability({
    id: TASK_CAPABILITIES.TASK_PARALLEL,
    title: 'Parallel agent task',
    description: 'Run a provider-native coordinated multi-agent task through a terminal visible result.',
    family: 'evidence_lifecycle',
    lifecycle: 'long_running',
    sideEffects: ['submit_prompt', 'persist_provider_state', 'generate_artifact'],
    implies: [TASK_CAPABILITIES.TASK_BACKGROUND, TASK_CAPABILITIES.TASK_INTERACTIVE],
    requiredEvidence: ['visible_agent_plan', 'visible_parallel_progress', 'terminal_state'],
    outputKinds: ['text', 'file', 'website'],
  }),
] satisfies readonly TaskCapabilityDefinition[])

const PROVIDER_TASK_CAPABILITY_ROUTES = Object.freeze([
  route('chatgpt', TASK_CAPABILITIES.CONVERSATION_CHAT, 'supported', 'visible-conversation', ['conversation-workflow']),
  route('chatgpt', TASK_CAPABILITIES.FILE_UPLOAD, 'supported', 'visible-file-attachment', ['conversation-workflow']),
  route('claude', TASK_CAPABILITIES.CONVERSATION_CHAT, 'supported', 'visible-conversation', ['conversation-workflow']),
  route('claude', TASK_CAPABILITIES.FILE_UPLOAD, 'supported', 'visible-file-attachment', ['conversation-workflow', 'native-project']),
  route('claude', TASK_CAPABILITIES.WORKSPACE_NATIVE, 'supported', 'native-project', ['native-project']),
  route('gemini', TASK_CAPABILITIES.CONVERSATION_CHAT, 'supported', 'visible-conversation', ['workspace-response-citations']),
  route('gemini', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('gemini', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'gemini-images-image-generation', ['gemini-image']),
  route('gemini', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'gemini-images-image', ['gemini-image']),
  route('grok', TASK_CAPABILITIES.CONVERSATION_CHAT, 'supported', 'visible-conversation', ['conversation-workflow']),
  route('grok', TASK_CAPABILITIES.FILE_UPLOAD, 'supported', 'visible-file-attachment', ['conversation-workflow']),
  route('grok', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'grok-imagine-image-generation', ['grok-image']),
  route('grok', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'grok-imagine-image', ['grok-image']),
  route('deepseek', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['workspace-response-baseline']),
  route('deepseek', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('perplexity', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['workspace-response-citations']),
  route('zai', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['workspace-response-baseline']),
  route('zai', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('doubao', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['workspace-response-baseline']),
  route('doubao', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('doubao', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'doubao-image-generation', ['doubao-image']),
  route('doubao', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'doubao-image', ['doubao-image']),
  route('kimi', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['conversation-workflow']),
  route('kimi', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('kimi', TASK_CAPABILITIES.SEARCH_WEB, 'experimental', 'kimi-web-search-auto', ['kimi-search']),
  route('kimi', TASK_CAPABILITIES.RESPONSE_CITATIONS, 'experimental', 'kimi-visible-citations', ['kimi-search']),
  route('chatgpt', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'chatgpt-image-generation', ['chatgpt-image']),
  route('chatgpt', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'chatgpt-image', ['chatgpt-image']),
  route('meta', TASK_CAPABILITIES.CONVERSATION_CHAT, 'experimental', 'visible-conversation', ['workspace-response-baseline']),
  route('meta', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('meta', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'meta-image-generation', ['meta-image']),
  route('meta', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'meta-image', ['meta-image']),
  route('arena', TASK_CAPABILITIES.CONVERSATION_CHAT, 'supported', 'visible-conversation', ['workspace-response-baseline']),
  route('arena', TASK_CAPABILITIES.CONVERSATION_CONTINUE, 'supported', 'visible-conversation-continuation', ['conversation-continuation']),
  route('arena', TASK_CAPABILITIES.MODEL_COMPARE, 'supported', 'visible-two-model-comparison', ['model-comparison']),
  route('arena', TASK_CAPABILITIES.FILE_UPLOAD, 'experimental', 'visible-file-attachment', ['file-selection']),
  route('arena', TASK_CAPABILITIES.SEARCH_WEB, 'experimental', 'arena-search-direct', ['arena-search']),
  route('arena', TASK_CAPABILITIES.RESPONSE_CITATIONS, 'experimental', 'arena-search-source-cards', ['arena-search']),
  route('arena', TASK_CAPABILITIES.IMAGE_INPUT, 'experimental', 'arena-image-input', ['arena-image']),
  route('arena', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'arena-image-generation', ['arena-image']),
  route('arena', TASK_CAPABILITIES.IMAGE_EDIT, 'experimental', 'arena-image-edit', ['arena-image']),
  route('arena', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'arena-image', ['arena-image']),
  route('dola', TASK_CAPABILITIES.IMAGE_GENERATION, 'experimental', 'dola-seedream-image-generation', ['dola-image']),
  route('dola', TASK_CAPABILITIES.ARTIFACT_DOWNLOAD, 'experimental', 'dola-seedream-image', ['dola-image']),
  route('arena', TASK_CAPABILITIES.WEBSITE_GENERATION, 'experimental', 'arena-code-website-generation', ['arena-code']),
  route('arena', TASK_CAPABILITIES.AGENT_EXECUTE, 'experimental', 'arena-agent-execution', ['arena-agent']),
  route('arena', TASK_CAPABILITIES.VIDEO_GENERATION, 'experimental', 'arena-video-generation', ['arena-video']),
] satisfies readonly ProviderTaskCapabilityRoute[])

const DEFINITION_BY_ID = new Map(TASK_CAPABILITY_CATALOG.map((definition) => [definition.id, definition]))
const ROUTE_BY_KEY = new Map(PROVIDER_TASK_CAPABILITY_ROUTES.map((entry) => [routeKey(entry.provider, entry.capability), entry]))

validateCatalog()

export function listTaskCapabilityDefinitions(): readonly TaskCapabilityDefinition[] {
  return TASK_CAPABILITY_CATALOG
}

export function listProviderTaskCapabilityRoutes(
  capability?: TaskCapabilityId,
): readonly ProviderTaskCapabilityRoute[] {
  return capability === undefined
    ? PROVIDER_TASK_CAPABILITY_ROUTES
    : Object.freeze(PROVIDER_TASK_CAPABILITY_ROUTES.filter((entry) => entry.capability === capability))
}

export function taskCapabilityDefinition(value: unknown): TaskCapabilityDefinition | null {
  return typeof value === 'string'
    ? DEFINITION_BY_ID.get(value as TaskCapabilityId) ?? null
    : null
}

export function normalizeTaskCapabilityRequirements(values: readonly unknown[]): readonly TaskCapabilityId[] {
  const requested: TaskCapabilityId[] = []
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    const definition = taskCapabilityDefinition(normalized)
    if (!definition) throw new TaskCapabilityRequestError(normalized || String(value))
    if (!requested.includes(definition.id)) requested.push(definition.id)
  }
  return expandImpliedCapabilities(requested)
}

export function resolveTaskCapabilityRoute(options: {
  requirements: readonly TaskCapabilityId[]
  candidates: readonly TaskCapabilityRouteCandidate[]
}): TaskCapabilityRouteDecision {
  const decision = resolveTaskCapabilityRoutes(options)
  if (!decision.ok) return decision
  const route = decision.routes[0]
  if (!route) {
    throw new Error('Capability route ranking returned no route for a successful decision.')
  }
  return Object.freeze({
    ok: true,
    route,
    evaluated: decision.evaluated,
  })
}

export function resolveTaskCapabilityRoutes(options: {
  requirements: readonly TaskCapabilityId[]
  candidates: readonly TaskCapabilityRouteCandidate[]
}): TaskCapabilityRoutesDecision {
  const requirements = expandImpliedCapabilities(options.requirements)
  const candidates = options.candidates.map((candidate, index) => ({
    candidate,
    preferenceRank: normalizedPreferenceRank(candidate.preferenceRank, index),
  }))
  const routeCandidates = candidates.flatMap(({ candidate, preferenceRank }) => {
    const routes = requirements.map((capability) => ROUTE_BY_KEY.get(routeKey(candidate.provider, capability)) ?? null)
    const missingCapabilities = requirements.filter((_capability, index) => routes[index] === null)
    const compatible = missingCapabilities.length === 0
    const matchedRoutes = routes.filter((entry): entry is ProviderTaskCapabilityRoute => entry !== null)
    const support = !compatible
      ? null
      : matchedRoutes.some((entry) => entry.support === 'experimental') ? 'experimental' as const : 'supported' as const
    const score = !compatible
      ? null
      : Object.freeze({
          runtimeEligibility: runtimeEligibilityScore(candidate.runtimeEligibility),
          evidenceMaturity: support === 'supported' ? 1 : 0,
          providerPreference: -preferenceRank,
        })
    const route = compatible && candidate.runtimeEligibility !== 'ineligible' && support
      ? Object.freeze({
          schema: TASK_CAPABILITY_ROUTE_SCHEMA_ID,
          provider: candidate.provider,
          requirements: Object.freeze([...requirements]),
          strategies: Object.freeze([...new Set(matchedRoutes.map((entry) => entry.strategy))]),
          support,
          evidence: Object.freeze([...new Set(matchedRoutes.flatMap((entry) => entry.evidence))]),
          runtimeEligibility: candidate.runtimeEligibility,
        } satisfies TaskCapabilityRoute)
      : null
    return [{ candidate, missingCapabilities, compatible, support, score, preferenceRank, route }]
  })
  const ranked = routeCandidates
    .filter((entry): entry is typeof entry & { route: TaskCapabilityRoute, score: NonNullable<typeof entry.score> } => (
      entry.route !== null && entry.score !== null
    ))
    .sort((left, right) => compareRouteScore(left.score, right.score))
  const rankByProvider = new Map(ranked.map((entry, index) => [entry.candidate.provider, index + 1]))
  const evaluated = routeCandidates.map((entry) => Object.freeze({
    provider: entry.candidate.provider,
    runtimeEligibility: entry.candidate.runtimeEligibility,
    compatible: entry.compatible,
    missingCapabilities: Object.freeze(entry.missingCapabilities),
    support: entry.support,
    rank: rankByProvider.get(entry.candidate.provider) ?? null,
    score: entry.score,
    reason: !entry.compatible
      ? 'capability_not_e2e_closed'
      : (entry.candidate.runtimeEligibility === 'ineligible'
          ? entry.candidate.reason ?? 'provider_runtime_ineligible'
          : null),
  } satisfies TaskCapabilityRouteEvaluation))

  if (ranked.length > 0) {
    return Object.freeze({
      ok: true,
      routes: Object.freeze(ranked.map((entry) => entry.route)),
      evaluated: Object.freeze(evaluated),
    })
  }

  return Object.freeze({
    ok: false,
    code: 'task_capability_route_unavailable',
    message: requirements.length === 0
      ? 'No provider is currently eligible for this request.'
      : `No provider can satisfy all required task capabilities: ${requirements.join(', ')}.`,
    requirements: Object.freeze([...requirements]),
    evaluated: Object.freeze(evaluated),
  })
}

function normalizedPreferenceRank(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function runtimeEligibilityScore(value: TaskCapabilityRouteCandidate['runtimeEligibility']) {
  if (value === 'eligible') return 2
  if (value === 'unchecked') return 1
  return 0
}

function compareRouteScore(
  left: NonNullable<TaskCapabilityRouteEvaluation['score']>,
  right: NonNullable<TaskCapabilityRouteEvaluation['score']>,
) {
  return right.runtimeEligibility - left.runtimeEligibility ||
    right.evidenceMaturity - left.evidenceMaturity ||
    right.providerPreference - left.providerPreference
}

export function validateTaskCapabilityRoute(
  value: unknown,
  expectedProvider?: ProviderId,
): TaskCapabilityRoute {
  if (!isPlainRecord(value)) throw new TypeError('Task capability route must be an object.')
  const keys = [
    'schema',
    'provider',
    'requirements',
    'strategies',
    'support',
    'evidence',
    'runtimeEligibility',
  ]
  if (!hasExactKeys(value, keys)) throw new TypeError(`Task capability route requires exact keys: ${keys.join(', ')}.`)
  if (value.schema !== TASK_CAPABILITY_ROUTE_SCHEMA_ID || !isProviderIdSyntax(value.provider)) {
    throw new TypeError('Task capability route identity is invalid.')
  }
  if (expectedProvider !== undefined && value.provider !== expectedProvider) {
    throw new TypeError('Task capability route provider does not match the job provider.')
  }
  if (!Array.isArray(value.requirements)) throw new TypeError('Task capability route requirements must be an array.')
  const rawRequirements = value.requirements
  const requirements = normalizeTaskCapabilityRequirements(rawRequirements)
  if (
    requirements.length !== rawRequirements.length ||
    requirements.some((capability, index) => capability !== rawRequirements[index])
  ) {
    throw new TypeError('Task capability route requirements must be normalized and implication-complete.')
  }
  if (
    value.runtimeEligibility !== 'eligible' &&
    value.runtimeEligibility !== 'ineligible' &&
    value.runtimeEligibility !== 'unchecked'
  ) {
    throw new TypeError('Task capability route runtime eligibility is invalid.')
  }
  const decision = resolveTaskCapabilityRoute({
    requirements,
    candidates: [{
      provider: value.provider,
      runtimeEligibility: value.runtimeEligibility,
    }],
  })
  if (!decision.ok || !sameTaskCapabilityRoute(decision.route, value)) {
    throw new TypeError('Task capability route does not match the declared provider matrix.')
  }
  return decision.route
}

function defineCapability(
  definition: Omit<TaskCapabilityDefinition, 'parametersSchema' | 'implies' | 'composesWith' | 'conflictsWith' | 'stability'> &
    Partial<Pick<TaskCapabilityDefinition, 'parametersSchema' | 'implies' | 'composesWith' | 'conflictsWith' | 'stability'>>,
): TaskCapabilityDefinition {
  return Object.freeze({
    ...definition,
    parametersSchema: definition.parametersSchema ?? EMPTY_PARAMETERS_SCHEMA,
    sideEffects: Object.freeze([...definition.sideEffects]),
    implies: Object.freeze([...(definition.implies ?? [])]),
    composesWith: Object.freeze([...(definition.composesWith ?? [])]),
    conflictsWith: Object.freeze([...(definition.conflictsWith ?? [])]),
    requiredEvidence: Object.freeze([...definition.requiredEvidence]),
    outputKinds: Object.freeze([...definition.outputKinds]),
    stability: definition.stability ?? 'candidate',
  })
}

function inputCapability(id: TaskCapabilityId, title: string, description: string) {
  return defineCapability({
    id,
    title,
    description,
    family: 'input',
    lifecycle: 'immediate',
    sideEffects: ['upload_content'],
    requiredEvidence: ['visible_provider_input_acceptance'],
    outputKinds: [],
  })
}

function reasoningCapability(id: TaskCapabilityId, title: string, description: string) {
  return defineCapability({
    id,
    title,
    description,
    family: 'retrieval_reasoning',
    lifecycle: 'interactive',
    sideEffects: ['submit_prompt'],
    requiredEvidence: ['visible_strategy_execution', 'correlated_visible_response'],
    outputKinds: ['text'],
  })
}

function generationCapability(
  id: TaskCapabilityId,
  title: string,
  subject: string,
  outputKind: TaskCapabilityOutputKind,
  lifecycle: TaskCapabilityLifecycle = 'interactive',
) {
  return defineCapability({
    id,
    title,
    description: `Produce a completed provider-native ${subject} artifact.`,
    family: outputKind === 'image' || outputKind === 'audio' || outputKind === 'video'
      ? 'media_generation'
      : 'artifact_generation',
    parametersSchema: objectParameters({
      format: { type: 'string', minLength: 1, maxLength: 40 },
    }),
    lifecycle,
    sideEffects: ['submit_prompt', 'generate_artifact', 'persist_provider_state'],
    requiredEvidence: ['completed_visible_artifact', 'bounded_artifact_reference'],
    outputKinds: [outputKind],
  })
}

function objectParameters(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): JsonSchema {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({ ...properties }),
    ...(required.length === 0 ? {} : { required: Object.freeze([...required]) }),
  })
}

function enumProperty(values: readonly string[]) {
  return Object.freeze({ type: 'string', enum: Object.freeze([...values]) })
}

function route(
  provider: ProviderId,
  capability: TaskCapabilityId,
  support: ProviderTaskCapabilityRoute['support'],
  strategy: string,
  evidence: readonly string[],
): ProviderTaskCapabilityRoute {
  return Object.freeze({
    provider,
    capability,
    support,
    strategy,
    evidence: Object.freeze([...evidence]),
  })
}

function routeKey(provider: ProviderId, capability: TaskCapabilityId) {
  return `${provider}:${capability}`
}

function expandImpliedCapabilities(input: readonly TaskCapabilityId[]) {
  const expanded: TaskCapabilityId[] = []
  const visit = (capability: TaskCapabilityId) => {
    if (expanded.includes(capability)) return
    const definition = DEFINITION_BY_ID.get(capability)
    if (!definition) throw new TaskCapabilityRequestError(capability)
    expanded.push(capability)
    for (const implied of definition.implies) visit(implied)
  }
  for (const capability of input) visit(capability)
  return Object.freeze(expanded)
}

function validateCatalog() {
  if (DEFINITION_BY_ID.size !== TASK_CAPABILITY_CATALOG.length) {
    throw new Error('Task capability catalog contains duplicate ids.')
  }
  for (const definition of TASK_CAPABILITY_CATALOG) {
    for (const implied of definition.implies) {
      if (!DEFINITION_BY_ID.has(implied)) {
        throw new Error(`Task capability ${definition.id} implies unknown capability ${implied}.`)
      }
    }
  }
  if (ROUTE_BY_KEY.size !== PROVIDER_TASK_CAPABILITY_ROUTES.length) {
    throw new Error('Provider task capability matrix contains duplicate routes.')
  }
  for (const entry of PROVIDER_TASK_CAPABILITY_ROUTES) {
    if (!isProviderIdSyntax(entry.provider) || !DEFINITION_BY_ID.has(entry.capability)) {
      throw new Error('Provider task capability route identity is invalid.')
    }
    if (entry.evidence.length === 0 || !entry.strategy) {
      throw new Error(`Provider task capability route ${routeKey(entry.provider, entry.capability)} lacks evidence.`)
    }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function sameTaskCapabilityRoute(expected: TaskCapabilityRoute, actual: Record<string, unknown>) {
  return actual.schema === expected.schema &&
    actual.provider === expected.provider &&
    actual.support === expected.support &&
    actual.runtimeEligibility === expected.runtimeEligibility &&
    sameStringArray(actual.requirements, expected.requirements) &&
    sameStringArray(actual.strategies, expected.strategies) &&
    sameStringArray(actual.evidence, expected.evidence)
}

function sameStringArray(actual: unknown, expected: readonly string[]) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
}
