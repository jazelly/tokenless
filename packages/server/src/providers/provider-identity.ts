export type ProviderId = string
export type ProviderStage = 'experimental' | 'supported' | 'disabled'
export type ProviderExecutionMode = 'browser' | 'direct'

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export function isProviderIdSyntax(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value)
}

export const PROVIDER_CAPABILITIES = Object.freeze({
  CAPABILITY_INSPECT: 'capability.inspect',
  MODEL_CHOICE: 'model.choice',
  EFFORT_CHOICE: 'effort.choice',
  FILE_UPLOAD: 'file.upload',
  WORKSPACE_ENSURE: 'workspace.ensure',
  CONVERSATION_CONTINUE: 'conversation.continue',
  DIAGNOSTICS: 'diagnostics',
  IMAGE_GENERATION: 'image.generation',
  ARENA_SURFACE: 'arena.surface',
  GROK_IMAGINE: 'grok.imagine',
  GEMINI_IMAGE_SURFACE: 'gemini.image.surface',
  DOLA_IMAGE_SURFACE: 'dola.image.surface',
  QWEN_MODE: 'qwen.mode',
  DEEPSEEK_MODE: 'deepseek.mode',
  DEEPSEEK_DEEPTHINK: 'deepseek.deepthink',
  DEEPSEEK_SEARCH: 'deepseek.search',
  DOUBAO_MODE: 'doubao.mode',
  DOUBAO_SKILL: 'doubao.skill',
  KIMI_SEARCH: 'kimi.search',
  KIMI_PLUGIN: 'kimi.plugin',
  KIMI_SKILL: 'kimi.skill',
  GITHUB_COPILOT_MODE: 'github-copilot.mode',
  GITHUB_COPILOT_REPOSITORY: 'github-copilot.repository',
  GITHUB_COPILOT_USAGE: 'github-copilot.usage',
})

export type ProviderCapabilityId = typeof PROVIDER_CAPABILITIES[keyof typeof PROVIDER_CAPABILITIES]
