import type { DashboardRateLimitRule, DashboardRateLimits } from 'tokenless-internal-shared/dashboard'
import { providerRateLimitCatalog } from './rate-limit-policy.js'

// A read-only view of the same catalog used by capacity preflight.
export function providerRateLimitTable(providers: readonly { id: string; label: string }[]): DashboardRateLimits {
  const catalog = providerRateLimitCatalog()
  const labels = new Map(providers.map((provider) => [provider.id, provider.label]))
  for (const [id, provider] of Object.entries(catalog.providers)) labels.set(id, provider.label)
  const rules: DashboardRateLimitRule[] = []
  for (const [provider, providerLabel] of labels) {
    const entry = catalog.providers[provider]
    for (const rule of entry?.rules ?? []) {
      const sourceIds = new Set(rule.evidence.flatMap((evidence) => evidence.sourceIds))
      const actions = [...rule.appliesTo.actions]
      rules.push({
        id: rule.id, provider, providerLabel,
        requestType: actions.includes('interactive.usage') || (actions.includes('file.upload') && actions.includes('prompt.submit'))
          ? 'shared' : actions.includes('file.upload') ? 'file' : 'message',
        actions, plans: [...rule.appliesTo.planIds], models: [...rule.appliesTo.modelFamilies], modes: [...(rule.appliesTo.modes ?? [])],
        scope: rule.scope, windowKind: rule.window.kind, windowSeconds: rule.window.durationSeconds ?? null,
        allowanceKind: rule.allowance.kind as string, count: typeof rule.allowance.count === 'number' ? rule.allowance.count : null,
        allowanceDetails: rule.allowance,
        unit: rule.meter.unit,
        enforcement: rule.status === 'active' && rule.allowance.kind === 'exact' && (rule.window.kind === 'request' || rule.window.durationSeconds)
          ? 'preflight' : rule.allowance.kind === 'unknown' ? 'unknown' : 'non_numeric',
        sources: [...sourceIds].map((id) => catalog.sources[id]).filter((source) => source !== undefined).map((source) => ({
          title: String(source.title), url: String(source.url), retrievedAt: String(source.retrievedAt),
        })),
      })
    }
    for (const requestType of ['message', 'image', 'file'] as const) {
      if (rules.some((rule) => rule.provider === provider && rule.requestType === requestType)) continue
      rules.push({
        id: `${provider}.${requestType}.unrecorded`, provider, providerLabel, requestType,
        actions: [], plans: [], models: [], modes: [], scope: 'unknown', windowKind: 'unknown', windowSeconds: null,
        allowanceKind: 'unknown', count: null, unit: '', enforcement: 'unknown', sources: [],
      })
    }
  }
  // Proposed policies are visible but never consumed by the execution policy.
  for (const policy of catalog.proposedPolicies) {
    rules.unshift({ ...policy, providerLabel: labels.get(policy.provider) ?? policy.provider })
  }
  return { revision: catalog.revision, reviewedAt: catalog.reviewedAt, reviewAfter: catalog.reviewAfter, rules }
}
