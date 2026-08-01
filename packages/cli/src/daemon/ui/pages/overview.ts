import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'
import { jobRows, metric, pageHeader } from './shared.js'

export function renderOverview(context: ViewContext) {
  const waiting = context.snapshot.jobs.filter((job: JsonRecord) => job.status === 'waiting_for_user')
  const defaultProfile = context.snapshot.profiles.find((profile: JsonRecord) => profile.isDefault) ?? context.snapshot.profiles[0]
  const readyProviders = context.snapshot.providers.filter((provider: JsonRecord) => provider.profiles.some((profile: JsonRecord) => profile.profileId === defaultProfile?.slug && profile.enabled && profile.runtimeEligibility === 'eligible'))
  const action = context.snapshot.diagnostics.find((item: JsonRecord) => item.state !== 'ok') ?? waiting[0]
  const profileNote = defaultProfile
    ? `${context.t('default')}: ${defaultProfile.label}${defaultProfile.preferences.roleLabel ? ` · ${defaultProfile.preferences.roleLabel}` : ''}`
    : `0 ${context.t('configuredUnit')}`
  const openButton = defaultProfile
    ? `<button class="button primary" data-action="open-profile" data-profile="${context.esc(defaultProfile.slug)}">${context.esc(context.t('openBrowser'))}</button>`
    : ''
  return `<section class="page">${pageHeader(context, context.t('operationalSummary'), context.t('overviewLede'), openButton)}
    ${action ? `<div class="notice"><div><strong>${context.esc(context.t('actionRequired'))}</strong><br>${context.esc(action.message ?? action.blocker?.message ?? action.status)}</div></div>` : ''}
    <div class="grid metrics">
      ${metric(context, context.t('daemon'), context.snapshot.daemon.version, `${Math.floor(context.snapshot.daemon.uptimeMs / 60000)} ${context.t('uptimeUnit')}`)}
      ${metric(context, context.t('browser'), context.snapshot.runtime.status, `${context.snapshot.runtime.activeJobCount} ${context.t('activeUnit')}`)}
      ${metric(context, context.t('activeProfiles'), context.snapshot.runtime.activeProfileCount, profileNote)}
      ${metric(context, context.t('waitingJobs'), waiting.length, `${context.snapshot.jobs.length} ${context.t('durableUnit')}`)}
    </div>
    <div class="section grid two">
      <section class="panel"><div class="panel-head"><h2>${context.esc(context.t('providerReadiness'))}</h2><span class="badge supported">${readyProviders.length}/${context.snapshot.providers.length}</span></div>${providerRows(context)}</section>
      <section class="panel"><div class="panel-head"><h2>${context.esc(context.t('recentJobs'))}</h2></div>${jobRows(context, context.snapshot.jobs.slice(0, 6), true)}</section>
    </div>
  </section>`
}

function providerRows(context: ViewContext) {
  const profile = context.selectedProfile || context.snapshot.profiles[0]?.slug
  const rows = context.snapshot.providers.map((provider: JsonRecord) => {
    const state = provider.profiles.find((entry: JsonRecord) => entry.profileId === profile)
    return `<li class="list-row"><div class="row-title"><strong>${context.esc(provider.label)}</strong><span>${context.esc(provider.stage)}</span></div><span class="status ${context.esc(state?.runtimeEligibility ?? 'ineligible')}">${context.esc(state?.runtimeEligibility ?? 'ineligible')}</span><span class="secondary">${context.esc(context.age(state?.observation?.checkedAt))}</span><button class="button" data-nav="providers">${context.esc(context.t('details'))}</button></li>`
  }).join('')
  return `<ul class="list">${rows}</ul>`
}
