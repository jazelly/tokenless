import type { ProviderId } from './provider-identity.js'
import type { TaskCapabilityRoute } from './task-capabilities.js'

export type ApiProxyStructuredControlRequirements = Readonly<{
  tools: boolean
  multipleCalls: boolean
  strictTools: boolean
  toolHistory: boolean
  responseFormat: 'text' | 'json_object' | 'json_schema'
}>

export type ApiProxyStructuredControlStrategy = 'prompt_tool_envelope' | 'prompt_json_envelope'

export type ApiProxyStructuredControlCandidate = Readonly<{
  provider: ProviderId
  capabilityRoute: TaskCapabilityRoute
  preferenceRank: number
}>

export type ApiProxyStructuredControlRoute = Readonly<{
  provider: ProviderId
  capabilityRoute: TaskCapabilityRoute
  strategy: ApiProxyStructuredControlStrategy
  evidence: readonly string[]
}>

type ApiProxyStructuredControlDeclaration = Readonly<{
  provider: ProviderId
  tools: boolean
  multipleCalls: boolean
  strictTools: boolean
  toolHistory: boolean
  jsonObject: boolean
  jsonSchema: boolean
  evidence: readonly string[]
}>

// This is deliberately a narrow evidence matrix for the Universal API. A
// visible conversation route alone does not prove structured-control framing.
const API_PROXY_STRUCTURED_CONTROL = Object.freeze([
  declaration({
    provider: 'deepseek',
    tools: true,
    multipleCalls: true,
    strictTools: true,
    toolHistory: true,
    jsonObject: true,
    jsonSchema: true,
    evidence: [
      'openai-tool-choice-strict-deepseek-2026-08-15',
      'openai-multiple-tool-calls-deepseek-2026-08-15',
      'openai-structured-output-deepseek-2026-08-15',
      'openai-responses-deepseek-2026-08-15',
    ],
  }),
  declaration({
    provider: 'chatgpt',
    tools: true,
    multipleCalls: false,
    strictTools: true,
    toolHistory: true,
    jsonObject: true,
    jsonSchema: true,
    evidence: [
      'shared-structured-control-chatgpt-2026-08-15',
      'openai-auto-provider-routing-2026-08-15',
    ],
  }),
] satisfies readonly ApiProxyStructuredControlDeclaration[])

const DECLARATION_BY_PROVIDER = new Map(API_PROXY_STRUCTURED_CONTROL.map((entry) => [entry.provider, entry]))

export function resolveApiProxyStructuredControlRoutes(options: {
  requirements: ApiProxyStructuredControlRequirements
  candidates: readonly ApiProxyStructuredControlCandidate[]
  affinityProvider?: ProviderId | null | undefined
}): readonly ApiProxyStructuredControlRoute[] {
  const routes = options.candidates.flatMap((candidate) => {
    const declared = DECLARATION_BY_PROVIDER.get(candidate.provider)
    if (!declared || !supports(declared, options.requirements)) return []
    const strategy: ApiProxyStructuredControlStrategy = options.requirements.tools
      ? 'prompt_tool_envelope'
      : 'prompt_json_envelope'
    return [{
      provider: candidate.provider,
      capabilityRoute: candidate.capabilityRoute,
      strategy,
      evidence: declared.evidence,
      preferenceRank: candidate.preferenceRank,
    }]
  })
  routes.sort((left, right) => {
    const leftAffinity = left.provider === options.affinityProvider ? 1 : 0
    const rightAffinity = right.provider === options.affinityProvider ? 1 : 0
    return rightAffinity - leftAffinity || left.preferenceRank - right.preferenceRank
  })
  return Object.freeze(routes.map(({ preferenceRank: _preferenceRank, ...route }) => Object.freeze(route)))
}

function supports(
  declared: ApiProxyStructuredControlDeclaration,
  requirements: ApiProxyStructuredControlRequirements,
) {
  if (requirements.tools && !declared.tools) return false
  if (requirements.multipleCalls && !declared.multipleCalls) return false
  if (requirements.strictTools && !declared.strictTools) return false
  if (requirements.toolHistory && !declared.toolHistory) return false
  if (requirements.responseFormat === 'json_object' && !declared.jsonObject) return false
  if (requirements.responseFormat === 'json_schema' && !declared.jsonSchema) return false
  return true
}

function declaration(value: ApiProxyStructuredControlDeclaration): ApiProxyStructuredControlDeclaration {
  return Object.freeze({ ...value, evidence: Object.freeze([...value.evidence]) })
}
