import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CATALOG_SCHEMA = 'tokenless.provider-rate-limit-catalog.v1'
const PROJECTION_SCHEMA = 'tokenless.provider-capacity-projection.v1'

type JsonRecord = Record<string, unknown>

type CatalogPlan = {
  id: string
  family: string
  labels: readonly string[]
}

type CatalogRule = {
  id: string
  status: string
  appliesTo: {
    planIds: readonly string[]
    accessClasses: readonly string[]
    modelFamilies: readonly string[]
    modes?: readonly string[] | undefined
    actions: readonly string[]
  }
  window: {
    kind: string
    durationSeconds?: number | undefined
  }
  allowance: JsonRecord & {
    kind: string
    count?: number | undefined
  }
}

type CatalogProvider = {
  label: string
  plans: readonly CatalogPlan[]
  rules: readonly CatalogRule[]
}

type RuntimeProviderDefault = {
  modelFamily: string
  promptAction: string
}

export type ProviderRateLimitCatalog = {
  schema: typeof CATALOG_SCHEMA
  catalogVersion: number
  revision: string
  reviewedAt: string
  reviewAfter: string
  runtimePolicy: {
    exactAllowanceHeadroomRatio: number
    headroomMinimumAllowance: number
    burstRatio: number
    minimumBurstUnits: number
    maximumBurstUnits: number
    providerDefaults: Readonly<Record<string, RuntimeProviderDefault>>
  }
  sources: Readonly<Record<string, JsonRecord>>
  providers: Readonly<Record<string, CatalogProvider>>
}

export type ProviderRateLimitHistoryEvent = {
  submittedAt: string
  requestJson: unknown
}

export type ProviderCapacityInput = {
  provider: string
  profileId: string
  accessClass: string
  tierLabel?: string | null | undefined
  subscriptionLabel?: string | null | undefined
  requestJson: unknown
  history: readonly ProviderRateLimitHistoryEvent[]
  now?: string | Date | undefined
}

export type ProviderRuleCapacityProjection = {
  ruleId: string
  knowledge: 'official_exact' | 'non_numeric'
  action: string
  windowSeconds: number | null
  publishedAllowance: number | null
  effectiveAllowance: number | null
  usedUnits: number | null
  requestedUnits: number
  remainingUnits: number | null
  burstUnits: number | null
  cadenceSeconds: number | null
  decision: 'admit' | 'defer' | 'unknown'
  reason: string
}

export type ProviderCapacityProjection = {
  schema: typeof PROJECTION_SCHEMA
  catalogVersion: number
  catalogRevision: string
  provider: string
  profileId: string
  evaluatedAt: string
  subscription: {
    accessClass: string
    observedLabel: string | null
    planId: string
    match: 'label' | 'access_class' | 'unknown'
  }
  decision: 'admit' | 'defer' | 'unknown'
  reason: string
  rules: readonly ProviderRuleCapacityProjection[]
}

export interface ProviderCapacityPolicy {
  project(input: ProviderCapacityInput): ProviderCapacityProjection
}

let catalogCache: ProviderRateLimitCatalog | undefined

export function providerRateLimitCatalog(): ProviderRateLimitCatalog {
  catalogCache ??= readAndValidateCatalog()
  return catalogCache
}

export function validateProviderRateLimitCatalog(input: unknown): ProviderRateLimitCatalog {
  const root = record(input, 'catalog')
  if (root.schema !== CATALOG_SCHEMA) fail(`catalog.schema must equal ${CATALOG_SCHEMA}`)
  positiveInteger(root.catalogVersion, 'catalog.catalogVersion')
  isoDate(root.revision, 'catalog.revision')
  isoDate(root.reviewedAt, 'catalog.reviewedAt')
  isoDate(root.reviewAfter, 'catalog.reviewAfter')

  const runtimePolicy = record(root.runtimePolicy, 'catalog.runtimePolicy')
  ratio(runtimePolicy.exactAllowanceHeadroomRatio, 'runtimePolicy.exactAllowanceHeadroomRatio')
  positiveInteger(runtimePolicy.headroomMinimumAllowance, 'runtimePolicy.headroomMinimumAllowance')
  ratio(runtimePolicy.burstRatio, 'runtimePolicy.burstRatio')
  positiveInteger(runtimePolicy.minimumBurstUnits, 'runtimePolicy.minimumBurstUnits')
  positiveInteger(runtimePolicy.maximumBurstUnits, 'runtimePolicy.maximumBurstUnits')
  if (Number(runtimePolicy.minimumBurstUnits) > Number(runtimePolicy.maximumBurstUnits)) {
    fail('runtimePolicy.minimumBurstUnits must not exceed maximumBurstUnits')
  }
  const providerDefaults = record(runtimePolicy.providerDefaults, 'runtimePolicy.providerDefaults')

  const sources = record(root.sources, 'catalog.sources')
  if (Object.keys(sources).length === 0) fail('catalog.sources must not be empty')
  for (const [sourceId, sourceValue] of Object.entries(sources)) {
    const source = record(sourceValue, `sources.${sourceId}`)
    nonemptyString(source.publisher, `sources.${sourceId}.publisher`)
    nonemptyString(source.title, `sources.${sourceId}.title`)
    const url = nonemptyString(source.url, `sources.${sourceId}.url`)
    if (!url.startsWith('https://')) fail(`sources.${sourceId}.url must use HTTPS`)
    if (source.authority !== 'official') fail(`sources.${sourceId}.authority must be official`)
    isoDate(source.retrievedAt, `sources.${sourceId}.retrievedAt`)
  }

  const providers = record(root.providers, 'catalog.providers')
  if (Object.keys(providers).length === 0) fail('catalog.providers must not be empty')
  const allRuleIds = new Set<string>()
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = record(providerValue, `providers.${providerId}`)
    nonemptyString(provider.label, `providers.${providerId}.label`)
    const plans = array(provider.plans, `providers.${providerId}.plans`)
    const planIds = new Set<string>()
    for (const [index, planValue] of plans.entries()) {
      const plan = record(planValue, `providers.${providerId}.plans[${index}]`)
      const planId = nonemptyString(plan.id, `providers.${providerId}.plans[${index}].id`)
      if (planIds.has(planId)) fail(`provider ${providerId} has duplicate plan ${planId}`)
      planIds.add(planId)
      nonemptyString(plan.family, `providers.${providerId}.plans[${index}].family`)
      stringArray(plan.labels, `providers.${providerId}.plans[${index}].labels`)
    }
    if (!planIds.has('unknown')) fail(`provider ${providerId} must declare an unknown plan`)
    const defaults = record(providerDefaults[providerId], `runtimePolicy.providerDefaults.${providerId}`)
    nonemptyString(defaults.modelFamily, `runtimePolicy.providerDefaults.${providerId}.modelFamily`)
    nonemptyString(defaults.promptAction, `runtimePolicy.providerDefaults.${providerId}.promptAction`)

    const rules = array(provider.rules, `providers.${providerId}.rules`)
    for (const [index, ruleValue] of rules.entries()) {
      const path = `providers.${providerId}.rules[${index}]`
      const rule = record(ruleValue, path)
      const ruleId = nonemptyString(rule.id, `${path}.id`)
      if (allRuleIds.has(ruleId)) fail(`duplicate rule id ${ruleId}`)
      allRuleIds.add(ruleId)
      nonemptyString(rule.status, `${path}.status`)
      const appliesTo = record(rule.appliesTo, `${path}.appliesTo`)
      const rulePlanIds = stringArray(appliesTo.planIds, `${path}.appliesTo.planIds`)
      if (rulePlanIds.some((planId) => !planIds.has(planId))) fail(`${ruleId} references an unknown plan`)
      stringArray(appliesTo.accessClasses, `${path}.appliesTo.accessClasses`)
      stringArray(appliesTo.modelFamilies, `${path}.appliesTo.modelFamilies`)
      stringArray(appliesTo.actions, `${path}.appliesTo.actions`)
      if (appliesTo.modes !== undefined) stringArray(appliesTo.modes, `${path}.appliesTo.modes`)
      const window = record(rule.window, `${path}.window`)
      nonemptyString(window.kind, `${path}.window.kind`)
      if (window.durationSeconds !== undefined) positiveInteger(window.durationSeconds, `${path}.window.durationSeconds`)
      const allowance = record(rule.allowance, `${path}.allowance`)
      const allowanceKind = nonemptyString(allowance.kind, `${path}.allowance.kind`)
      if (allowanceKind === 'exact') {
        positiveInteger(allowance.count, `${path}.allowance.count`)
        const evidence = array(rule.evidence, `${path}.evidence`)
        if (!evidence.some((entry) => record(entry, `${path}.evidence`).kind === 'official_exact')) {
          fail(`${ruleId} has an exact allowance without official_exact evidence`)
        }
      }
    }
  }

  walkSourceReferences(root, new Set(Object.keys(sources)))
  for (const providerValue of Object.values(providers)) {
    for (const ruleValue of array(record(providerValue, 'provider').rules, 'provider.rules')) {
      const allowance = record(record(ruleValue, 'rule').allowance, 'rule.allowance')
      if (typeof allowance.basisRuleId === 'string' && !allRuleIds.has(allowance.basisRuleId)) {
        fail(`allowance references unknown basis rule ${allowance.basisRuleId}`)
      }
    }
  }
  return root as ProviderRateLimitCatalog
}

export const providerCapacityPolicy: ProviderCapacityPolicy = Object.freeze({
  project(input: ProviderCapacityInput): ProviderCapacityProjection {
    const catalog = providerRateLimitCatalog()
    const provider = catalog.providers[input.provider]
    const now = normalizeNow(input.now)
    const tierLabel = normalizeObservedLabel(input.tierLabel)
    const subscriptionLabel = normalizeObservedLabel(input.subscriptionLabel)
    const observedLabel = tierLabel ?? subscriptionLabel
    if (!provider) return unknownProjection(catalog, input, now, observedLabel, 'Provider is not present in the rate-limit catalog.')
    const subscription = resolvePlan(provider, input.accessClass, [tierLabel, subscriptionLabel])
    const defaults = catalog.runtimePolicy.providerDefaults[input.provider]
    if (!defaults) return unknownProjection(catalog, input, now, observedLabel, 'Provider runtime defaults are unavailable.')
    const requestContext = requestRateContext(input.provider, input.requestJson, defaults)
    const matchingRules = provider.rules.filter((rule) => rule.status === 'active' &&
      rule.appliesTo.planIds.includes(subscription.planId) &&
      rule.appliesTo.accessClasses.includes(input.accessClass) &&
      ruleMatchesContext(rule, requestContext))
    const rules = matchingRules.map((rule) => projectRule(catalog, rule, input, requestContext, now))
    const deferred = rules.filter((rule) => rule.decision === 'defer')
    const numeric = rules.filter((rule) => rule.knowledge === 'official_exact')
    const unknown = rules.filter((rule) => rule.decision === 'unknown')
    const decision: ProviderCapacityProjection['decision'] = deferred.length > 0
      ? 'defer'
      : unknown.length > 0 ? 'unknown' : numeric.length > 0 ? 'admit' : 'unknown'
    const reason = deferred.length > 0
      ? 'At least one known provider allowance cannot admit this request.'
      : unknown.length > 0
        ? 'At least one applicable allowance is non-numeric; Tokenless preserves the uncertainty and allows execution.'
        : numeric.length > 0
          ? 'Known numeric provider allowances have capacity for this request.'
          : 'No enforceable numeric allowance is known; Tokenless preserves the uncertainty and allows execution.'
    return {
      schema: PROJECTION_SCHEMA,
      catalogVersion: catalog.catalogVersion,
      catalogRevision: catalog.revision,
      provider: input.provider,
      profileId: input.profileId,
      evaluatedAt: now.toISOString(),
      subscription: {
        accessClass: input.accessClass,
        observedLabel: subscription.observedLabel ?? observedLabel,
        planId: subscription.planId,
        match: subscription.match,
      },
      decision,
      reason,
      rules,
    }
  },
})

function projectRule(
  catalog: ProviderRateLimitCatalog,
  rule: CatalogRule,
  input: ProviderCapacityInput,
  requestContext: RequestRateContext,
  now: Date,
): ProviderRuleCapacityProjection {
  const requestedUnits = unitsForRule(rule, requestContext)
  const action = rule.appliesTo.actions.join(',')
  if (
    rule.allowance.kind === 'exact' &&
    rule.window.kind === 'request' &&
    typeof rule.allowance.count === 'number' &&
    Number.isSafeInteger(rule.allowance.count)
  ) {
    const publishedAllowance = rule.allowance.count
    const deferred = requestedUnits > publishedAllowance
    return {
      ruleId: rule.id,
      knowledge: 'official_exact',
      action,
      windowSeconds: null,
      publishedAllowance,
      effectiveAllowance: publishedAllowance,
      usedUnits: 0,
      requestedUnits,
      remainingUnits: Math.max(0, publishedAllowance - requestedUnits),
      burstUnits: null,
      cadenceSeconds: null,
      decision: deferred ? 'defer' : 'admit',
      reason: deferred
        ? 'The request exceeds the provider published per-request allowance.'
        : 'The request is within the provider published per-request allowance.',
    }
  }
  if (
    rule.allowance.kind !== 'exact' ||
    typeof rule.allowance.count !== 'number' ||
    typeof rule.window.durationSeconds !== 'number' ||
    !Number.isSafeInteger(rule.allowance.count) ||
    !Number.isSafeInteger(rule.window.durationSeconds)
  ) {
    return {
      ruleId: rule.id,
      knowledge: 'non_numeric',
      action,
      windowSeconds: rule.window.durationSeconds ?? null,
      publishedAllowance: null,
      effectiveAllowance: null,
      usedUnits: null,
      requestedUnits,
      remainingUnits: null,
      burstUnits: null,
      cadenceSeconds: null,
      decision: 'unknown',
      reason: `Catalog allowance '${rule.allowance.kind}' is intentionally not converted into a numeric limit.`,
    }
  }

  const publishedAllowance = rule.allowance.count
  const windowSeconds = rule.window.durationSeconds
  const scheduledAllowance = publishedAllowance >= catalog.runtimePolicy.headroomMinimumAllowance
    ? Math.max(1, Math.floor(publishedAllowance * catalog.runtimePolicy.exactAllowanceHeadroomRatio))
    : publishedAllowance
  const effectiveAllowance = Math.min(publishedAllowance, Math.max(scheduledAllowance, requestedUnits))
  const burstUnits = Math.min(
    catalog.runtimePolicy.maximumBurstUnits,
    Math.max(catalog.runtimePolicy.minimumBurstUnits, Math.ceil(effectiveAllowance * catalog.runtimePolicy.burstRatio)),
  )
  const cadenceMs = windowSeconds * 1000 / effectiveAllowance
  const windowStartMs = now.getTime() - windowSeconds * 1000
  const usageTimestamps: number[] = []
  for (const event of input.history) {
    const eventMs = Date.parse(event.submittedAt)
    if (!Number.isFinite(eventMs) || eventMs <= windowStartMs || eventMs > now.getTime()) continue
    const eventContext = requestRateContext(input.provider, event.requestJson, catalog.runtimePolicy.providerDefaults[input.provider]!)
    const units = ruleMatchesContext(rule, eventContext) ? unitsForRule(rule, eventContext) : 0
    for (let unit = 0; unit < units; unit += 1) usageTimestamps.push(eventMs)
  }
  usageTimestamps.sort((left, right) => left - right)
  const usedUnits = usageTimestamps.length
  const remainingUnits = Math.max(0, effectiveAllowance - usedUnits)
  const slidingEligibleMs = slidingWindowEligibleAt(
    usageTimestamps,
    requestedUnits,
    effectiveAllowance,
    windowSeconds * 1000,
    now.getTime(),
  )
  const cadenceEligibleMs = gcraEligibleAt(
    usageTimestamps,
    requestedUnits,
    cadenceMs,
    burstUnits,
    now.getTime(),
  )
  const eligibleMs = Math.max(slidingEligibleMs, cadenceEligibleMs)
  const deferred = requestedUnits > 0 && eligibleMs > now.getTime()
  return {
    ruleId: rule.id,
    knowledge: 'official_exact',
    action,
    windowSeconds,
    publishedAllowance,
    effectiveAllowance,
    usedUnits,
    requestedUnits,
    remainingUnits,
    burstUnits,
    cadenceSeconds: cadenceMs / 1000,
    decision: deferred ? 'defer' : 'admit',
    reason: deferred
      ? Number.isFinite(eligibleMs)
        ? 'Known sliding-window capacity or smoothed burst cadence would be exceeded.'
        : 'The request itself exceeds the published allowance and has no time-based eligibility estimate.'
      : 'Known sliding-window capacity and burst cadence permit the request.',
  }
}

type RequestRateContext = {
  modelFamily: string
  modes: ReadonlySet<string>
  promptUnits: number
  fileUnits: number
  promptAction: string
}

function requestRateContext(provider: string, requestJson: unknown, defaults: RuntimeProviderDefault): RequestRateContext {
  const actions = isRecord(requestJson) && Array.isArray(requestJson.actions) ? requestJson.actions : []
  let promptUnits = 0
  let fileUnits = 0
  let selectedModel: string | null = null
  for (const value of actions) {
    if (!isRecord(value)) continue
    if (value.action === 'prompt.submit') promptUnits += 1
    if (value.action === 'file.upload') {
      const payload = isRecord(value.payload) ? value.payload : null
      fileUnits += payload && Array.isArray(payload.attachments) ? payload.attachments.length : 1
    }
    if (value.action === 'model.select' && isRecord(value.payload) && typeof value.payload.label === 'string') {
      selectedModel = value.payload.label
    }
  }
  const modelFamily = selectedModel ? modelFamilyFromLabel(provider, selectedModel, defaults.modelFamily) : defaults.modelFamily
  const modes = new Set<string>()
  if (/thinking/i.test(modelFamily) || (selectedModel && /thinking/i.test(selectedModel))) modes.add('manual_thinking')
  return { modelFamily, modes, promptUnits, fileUnits, promptAction: defaults.promptAction }
}

function modelFamilyFromLabel(provider: string, label: string, fallback: string) {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (provider === 'chatgpt') {
    if (normalized.includes('5 5') && normalized.includes('thinking')) return 'gpt-5.5-thinking'
    if (normalized.includes('5 5')) return 'gpt-5.5-instant'
    if (normalized.includes('gpt 5')) return 'gpt-5-family'
  }
  if (provider === 'claude' && normalized.includes('sonnet')) return 'claude-sonnet'
  return fallback
}

function ruleMatchesContext(rule: CatalogRule, context: RequestRateContext) {
  const modelMatches = rule.appliesTo.modelFamilies.includes('*') ||
    rule.appliesTo.modelFamilies.some((family) => family === context.modelFamily ||
      (family.endsWith('-family') && context.modelFamily.startsWith(family.slice(0, -'-family'.length))))
  if (!modelMatches) return false
  if (rule.appliesTo.modes && !rule.appliesTo.modes.some((mode) => context.modes.has(mode))) return false
  return unitsForRule(rule, context) > 0
}

function unitsForRule(rule: CatalogRule, context: RequestRateContext) {
  let units = 0
  for (const action of rule.appliesTo.actions) {
    if (action === 'file.upload') units += context.fileUnits
    if (action === 'prompt.submit' || action === context.promptAction || action === 'interactive.usage') {
      units += context.promptUnits
    }
  }
  return units
}

function slidingWindowEligibleAt(
  usageTimestamps: readonly number[],
  requestedUnits: number,
  allowance: number,
  windowMs: number,
  nowMs: number,
) {
  const overflow = usageTimestamps.length + requestedUnits - allowance
  if (overflow <= 0) return nowMs
  const releaseTimestamp = usageTimestamps[overflow - 1]
  if (releaseTimestamp === undefined) return Number.POSITIVE_INFINITY
  return releaseTimestamp + windowMs + 1
}

function gcraEligibleAt(
  usageTimestamps: readonly number[],
  requestedUnits: number,
  cadenceMs: number,
  burstUnits: number,
  nowMs: number,
) {
  if (requestedUnits <= 0 || !Number.isFinite(cadenceMs) || cadenceMs <= 0) return nowMs
  let theoreticalArrivalMs = usageTimestamps[0] ?? nowMs
  for (const timestamp of usageTimestamps) theoreticalArrivalMs = Math.max(theoreticalArrivalMs, timestamp) + cadenceMs
  const burstToleranceMs = Math.max(0, burstUnits - requestedUnits) * cadenceMs
  return Math.max(nowMs, theoreticalArrivalMs - burstToleranceMs)
}

function resolvePlan(provider: CatalogProvider, accessClass: string, observedLabels: readonly (string | null)[]) {
  for (const observedLabel of observedLabels) {
    if (!observedLabel) continue
    const normalized = comparableLabel(observedLabel)
    const match = provider.plans.find((plan) => plan.labels.some((label) => comparableLabel(label) === normalized))
      ?? provider.plans.find((plan) => plan.labels.some((label) => normalized.endsWith(comparableLabel(label))))
    if (match) return { planId: match.id, match: 'label' as const, observedLabel }
  }
  if (accessClass === 'signed_in_free') {
    const free = provider.plans.find((plan) => plan.family === 'free')
    if (free) return { planId: free.id, match: 'access_class' as const, observedLabel: null }
  }
  if (accessClass === 'guest') {
    const guest = provider.plans.find((plan) => plan.family === 'guest')
    if (guest) return { planId: guest.id, match: 'access_class' as const, observedLabel: null }
  }
  return { planId: 'unknown', match: 'unknown' as const, observedLabel: null }
}

function unknownProjection(
  catalog: ProviderRateLimitCatalog,
  input: ProviderCapacityInput,
  now: Date,
  observedLabel: string | null,
  reason: string,
): ProviderCapacityProjection {
  return {
    schema: PROJECTION_SCHEMA,
    catalogVersion: catalog.catalogVersion,
    catalogRevision: catalog.revision,
    provider: input.provider,
    profileId: input.profileId,
    evaluatedAt: now.toISOString(),
    subscription: { accessClass: input.accessClass, observedLabel, planId: 'unknown', match: 'unknown' },
    decision: 'unknown',
    reason,
    rules: [],
  }
}

function readAndValidateCatalog() {
  const candidates = [
    fileURLToPath(new URL('./provider-rate-limits.v1.json', import.meta.url)),
    fileURLToPath(new URL('../../catalog/provider-rate-limits.v1.json', import.meta.url)),
  ]
  const catalogPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!catalogPath) throw new Error(`Provider rate-limit catalog was not found at ${candidates.join(' or ')}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  } catch (error) {
    throw new Error(`Provider rate-limit catalog could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateProviderRateLimitCatalog(parsed)
}

function walkSourceReferences(value: unknown, sourceIds: ReadonlySet<string>, path = 'catalog') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkSourceReferences(entry, sourceIds, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sourceIds') {
      for (const sourceId of stringArray(entry, `${path}.sourceIds`)) {
        if (!sourceIds.has(sourceId)) fail(`${path}.sourceIds references unknown source ${sourceId}`)
      }
    } else {
      walkSourceReferences(entry, sourceIds, `${path}.${key}`)
    }
  }
}

function normalizeNow(value: string | Date | undefined) {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Provider capacity evaluation time must be a valid timestamp.')
  return date
}

function normalizeObservedLabel(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null
}

function comparableLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(`${path} must be an object`)
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${path} must be a non-empty array`)
  return value
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return value.map((entry, index) => nonemptyString(entry, `${path}[${index}]`))
}

function nonemptyString(value: unknown, path: string) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${path} must be a positive integer`)
  return Number(value)
}

function ratio(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`${path} must be greater than zero and no greater than one`)
  }
  return value
}

function isoDate(value: unknown, path: string) {
  const date = nonemptyString(value, path)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    fail(`${path} must be an ISO date`)
  }
  return date
}

function fail(message: string): never {
  throw new Error(`Invalid provider rate-limit catalog: ${message}`)
}
