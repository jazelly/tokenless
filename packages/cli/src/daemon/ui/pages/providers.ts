import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'
import { emptyState, pageHeader } from './shared.js'

export function renderProviders(context: ViewContext) {
  const profile = context.snapshot.profiles.find((entry: JsonRecord) => entry.slug === context.selectedProfile) ?? context.snapshot.profiles[0]
  const selector = `<label class="field"><span>${context.esc(context.t('selectProfile'))}</span><select id="provider-profile">${context.snapshot.profiles.map((entry: JsonRecord) => `<option value="${context.esc(entry.slug)}" ${entry.slug === profile?.slug ? 'selected' : ''}>${context.esc(entry.label)}</option>`).join('')}</select></label>`
  const cards = context.snapshot.providers.map((provider: JsonRecord) => {
    const state = provider.profiles.find((entry: JsonRecord) => entry.profileId === profile?.slug)
    const observation = state?.observation
    const enabled = state?.enabled === true
    return `<article class="panel provider-card">
      <div class="provider-top"><div><h3>${context.esc(provider.label)}</h3><p>${context.esc(provider.id)}</p></div><span class="badge ${context.esc(provider.stage)}">${context.esc(provider.stage)}</span></div>
      <label class="toggle"><input type="checkbox" data-action="toggle-provider" data-provider="${context.esc(provider.id)}" data-profile="${context.esc(profile?.slug)}" ${enabled ? 'checked' : ''}>${context.esc(enabled ? context.t('enabled') : context.t('disabled'))}</label>
      <div class="account"><strong>${context.esc(observation?.account?.name ?? observation?.access ?? context.t('neverChecked'))}</strong><span>${context.esc(observation?.account?.subscription ?? context.age(observation?.checkedAt))}</span></div>
      ${choiceControl(context, 'model', 'Model', state?.controls?.model, provider.id, profile?.slug)}
      ${choiceControl(context, 'effort', 'Effort', state?.controls?.effort, provider.id, profile?.slug)}
      <span class="status ${context.esc(state?.runtimeEligibility ?? 'ineligible')}">${context.esc(state?.runtimeEligibility ?? 'ineligible')}</span>
      <div class="button-row"><button class="button primary" data-provider-action="open" data-provider="${context.esc(provider.id)}" data-profile="${context.esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${context.esc(context.t('open'))}</button><button class="button" data-provider-action="readiness" data-provider="${context.esc(provider.id)}" data-profile="${context.esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${context.esc(context.t('checkNow'))}</button><button class="button" data-provider-action="controls" data-provider="${context.esc(provider.id)}" data-profile="${context.esc(profile?.slug)}" ${!enabled ? 'disabled' : ''}>${context.esc(context.t('inspectControls'))}</button></div>
    </article>`
  }).join('')
  return `<section class="page">${pageHeader(context, context.t('providerConfiguration'), context.t('providersLede'), selector)}${profile ? `<div class="grid three">${cards}</div>` : emptyState(context, context.t('empty'), context.t('profilesLede'))}</section>`
}

function choiceControl(context: ViewContext, kind: string, label: string, choices: JsonRecord[] | null | undefined, provider: string, profile: string) {
  if (!choices?.length) return ''
  return `<div class="field"><label>${context.esc(label)}</label><select data-choice-kind="${context.esc(kind)}" data-provider="${context.esc(provider)}" data-profile="${context.esc(profile)}"><option value="">—</option>${choices.map((choice) => `<option value="${context.esc(choice.label)}" ${choice.selected ? 'selected' : ''} ${choice.enabled ? '' : 'disabled'}>${context.esc(choice.label)}</option>`).join('')}</select></div>`
}
