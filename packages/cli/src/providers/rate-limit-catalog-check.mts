#!/usr/bin/env node

import { providerRateLimitCatalog } from './rate-limit-policy.js'
import { listProviderDescriptors } from './registry.js'

const catalog = providerRateLimitCatalog()
const supportedProviders = listProviderDescriptors()
  .filter((provider) => provider.stage !== 'disabled')
  .map((provider) => provider.id)
const missingProviders = supportedProviders.filter((provider) => !catalog.providers[provider])
if (missingProviders.length > 0) {
  throw new Error(`provider rate-limit catalog is missing supported providers: ${missingProviders.join(', ')}`)
}
const providerCount = Object.keys(catalog.providers).length
const planCount = Object.values(catalog.providers).reduce((count, provider) => count + provider.plans.length, 0)
const ruleCount = Object.values(catalog.providers).reduce((count, provider) => count + provider.rules.length, 0)

process.stdout.write(`${catalog.schema} ${catalog.revision}: ${providerCount} providers, ${planCount} plans, ${ruleCount} rules\n`)
if (Date.now() > Date.parse(`${catalog.reviewAfter}T23:59:59.999Z`)) {
  process.stderr.write(`warning: provider rate-limit catalog review was due after ${catalog.reviewAfter}\n`)
}
