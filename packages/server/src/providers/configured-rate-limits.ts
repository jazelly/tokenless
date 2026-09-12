import fs from 'node:fs'
import path from 'node:path'
import type { ConfiguredRateLimitRule } from 'tokenless-internal-shared/dashboard'
import type { ProviderRuleCapacityProjection } from './rate-limit-policy.js'
import { invalidInput } from '../errors.js'

export type RateLimitEvent = {
  profileId: string
  requestType: 'message' | 'image' | 'file'
  attemptedAt: string
}

export function validateConfiguredRateLimits(value: unknown): ConfiguredRateLimitRule[] {
  if (!Array.isArray(value)) throw invalidInput('rateLimits must be an array.')
  const ids = new Set<string>()
  return value.map((rule: unknown) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw invalidInput('Invalid rate limit rule.')
    const r = rule as Record<string, unknown>
    if (Object.keys(r).some((key) => !['id', 'provider', 'requestType', 'scope', 'windowSeconds', 'maxRequests'].includes(key))
      || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(r.id) || ids.has(r.id)
      || typeof r.provider !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(r.provider)
      || !['submission', 'message', 'image', 'file'].includes(String(r.requestType))
      || !['provider', 'profile'].includes(String(r.scope))
      || !Number.isSafeInteger(r.windowSeconds) || Number(r.windowSeconds) < 1
      || !Number.isSafeInteger(r.maxRequests) || Number(r.maxRequests) < 1) throw invalidInput('Invalid rate limit rule fields or duplicate id.')
    ids.add(r.id)
    return { ...r } as ConfiguredRateLimitRule
  })
}

export function readConfiguredRateLimits(homeDir: string) {
  let raw: string
  try { raw = fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const config = JSON.parse(raw)
  return validateConfiguredRateLimits(config.rateLimits ?? [])
}

export function rateLimitRequestType(request: any, action: any): RateLimitEvent['requestType'] | null {
  if (action?.action === 'file.upload') return 'file'
  if (action?.action !== 'prompt.submit') return null
  const requirements = request?.capabilityRoute?.requirements ?? request?.context?.requirements ?? []
  const image = request?.actions?.some((entry: any) => entry?.payload?.modality === 'image' || entry?.payload?.skill === 'image-generation')
    || requirements.includes('image.generation') || requirements.includes('image.edit')
    || ['image.generation', 'image.edit'].includes(request?.capabilityRoute?.capability)
  return image ? 'image' : 'message'
}

export function projectConfiguredRateLimit(
  rule: ConfiguredRateLimitRule,
  history: readonly RateLimitEvent[],
  profileId: string,
  requestedUnits: number,
  now: string,
): ProviderRuleCapacityProjection {
  const nowMs = Date.parse(now)
  const timestamps = history.filter((event) => (rule.scope === 'provider' || event.profileId === profileId)
    && (rule.requestType === 'submission' ? event.requestType !== 'file' : event.requestType === rule.requestType))
    .map((event) => Date.parse(event.attemptedAt)).filter((at) => at > nowMs - rule.windowSeconds * 1000 && at <= nowMs).sort((a, b) => a - b)
  const overflow = timestamps.length + requestedUnits - rule.maxRequests
  const eligibleAt = overflow > 0 ? timestamps[overflow - 1] : undefined
  return {
    ruleId: rule.id, knowledge: 'internal', action: rule.requestType === 'file' ? 'file.upload' : 'prompt.submit',
    windowSeconds: rule.windowSeconds, publishedAllowance: null, effectiveAllowance: rule.maxRequests,
    usedUnits: timestamps.length, requestedUnits, remainingUnits: Math.max(0, rule.maxRequests - timestamps.length),
    burstUnits: null, cadenceSeconds: null,
    eligibleAt: eligibleAt === undefined ? null : new Date(eligibleAt + rule.windowSeconds * 1000).toISOString(),
    decision: overflow > 0 ? 'defer' : 'admit',
    reason: overflow > 0 ? 'Configured rolling-window limit reached.' : 'Configured rolling-window limit has capacity.',
  }
}

export function configuredRuleUnits(rule: ConfiguredRateLimitRule, request: any, actionIndex?: number) {
  if (request?.executionMode && request.executionMode !== 'browser') return 0
  const actions = actionIndex === undefined ? request?.actions ?? [] : [request?.actions?.[actionIndex]]
  return actions.filter((action: any) => {
    const type = rateLimitRequestType(request, action)
    return type !== null && (rule.requestType === 'submission' ? type !== 'file' : type === rule.requestType)
  }).length
}
