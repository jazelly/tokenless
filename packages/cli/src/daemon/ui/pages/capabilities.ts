import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'
import { pageHeader } from './shared.js'

export function renderCapabilities(context: ViewContext) {
  const profile = context.snapshot.profiles.find((entry: JsonRecord) => entry.slug === context.selectedProfile) ?? context.snapshot.profiles[0]
  const groups: Record<string, JsonRecord[]> = context.snapshot.capabilities.reduce((result: Record<string, JsonRecord[]>, capability: JsonRecord) => {
    ;(result[capability.family] ??= []).push(capability)
    return result
  }, {})
  const content = Object.entries(groups).map(([family, capabilities]) => `<section class="section"><div class="section-title"><h2>${context.esc(context.capabilityFamilyLabel(family))}</h2><p>${capabilities.length}</p></div><div class="panel"><ul class="list">${capabilities.map((capability) => {
    const copy = context.capabilityText(capability)
    return `<li class="list-row"><div class="row-title"><strong>${context.esc(copy.title)}</strong><span>${context.esc(copy.description)}</span></div><span class="badge ${context.esc(capability.stability)}">${context.esc(capability.stability)}</span><span class="secondary">${context.esc(capabilityProviderSummary(context, capability, profile))}</span><button class="button" data-action="capability-detail" data-capability="${context.esc(capability.id)}">${context.esc(context.t('details'))}</button></li>`
  }).join('')}</ul></div></section>`).join('')
  const selector = profile
    ? `<label class="field"><span>${context.esc(context.t('selectProfile'))}</span><select id="capability-profile">${context.snapshot.profiles.map((entry: JsonRecord) => `<option value="${context.esc(entry.slug)}" ${entry.slug === profile.slug ? 'selected' : ''}>${context.esc(entry.label)}</option>`).join('')}</select></label>`
    : ''
  return `<section class="page">${pageHeader(context, context.t('capabilityCatalog'), context.t('capabilitiesLede'), selector)}${content}<dialog id="detail-dialog"></dialog></section>`
}

export function renderCapabilityDetail(context: ViewContext, capability: JsonRecord) {
  const copy = context.capabilityText(capability)
  return `<div class="dialog-head"><h2>${context.esc(copy.title)}</h2><button class="button" data-close-detail>${context.esc(context.t('cancel'))}</button></div><div class="dialog-body"><p>${context.esc(copy.description)}</p><p><span class="badge ${context.esc(capability.stability)}">${context.esc(capability.stability)}</span></p><h3>${context.esc(context.t('evidence'))}</h3><pre class="code-block">${context.esc(JSON.stringify({ required: capability.requiredEvidence, providers: capability.providers }, null, 2))}</pre></div>`
}

function capabilityProviderSummary(context: ViewContext, capability: JsonRecord, profile: JsonRecord | undefined) {
  if (!capability.providers.length) return context.t('noRoute')
  return capability.providers.map((route: JsonRecord) => {
    const provider = context.snapshot.providers.find((entry: JsonRecord) => entry.id === route.provider)
    const state = provider?.profiles.find((entry: JsonRecord) => entry.profileId === profile?.slug)
    return `${route.provider} · ${state?.runtimeEligibility ?? 'ineligible'}`
  }).join(', ')
}
