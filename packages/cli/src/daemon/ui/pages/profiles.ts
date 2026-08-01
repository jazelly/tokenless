import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'
import { emptyState, pageHeader } from './shared.js'

export function renderProfiles(context: ViewContext) {
  const cards = context.snapshot.profiles.map((profile: JsonRecord) => `<article class="panel pad">
    <div class="provider-top"><div><h3>${context.esc(profile.label)}</h3><p>${context.esc(profile.slug)} · ${context.esc(profile.preferences.roleLabel || (profile.import ? context.t('imported') : context.t('clean')))}</p></div>${profile.isDefault ? `<span class="badge supported">${context.esc(context.t('default'))}</span>` : ''}</div>
    <div class="section-title"><p><span class="status ${profile.lifecycle === 'ready' ? 'ok' : 'warn'}">${context.esc(profile.lifecycle)}</span></p><p>${context.esc(profile.preferences.enabledProviders.join(', ') || context.t('none'))}</p></div>
    <div class="button-row"><button class="button primary" data-action="open-profile" data-profile="${context.esc(profile.slug)}">${context.esc(context.t('open'))}</button><button class="button" data-action="edit-profile" data-profile="${context.esc(profile.slug)}">${context.esc(context.t('save'))}</button>${!profile.isDefault ? `<button class="button" data-action="default-profile" data-profile="${context.esc(profile.slug)}">${context.esc(context.t('setDefault'))}</button>` : ''}<button class="button danger" data-action="remove-profile" data-profile="${context.esc(profile.slug)}">${context.esc(context.t('remove'))}</button></div>
  </article>`).join('')
  const createButton = `<button class="button primary" data-action="show-create-profile">${context.esc(context.t('createProfile'))}</button>`
  return `<section class="page">${pageHeader(context, context.t('profileManagement'), context.t('profilesLede'), createButton)}
    <div class="notice"><div>${context.esc(context.t('cleanProfileNote'))}</div></div>
    ${context.snapshot.profiles.length ? `<div class="grid two">${cards}</div>` : emptyState(context, context.t('empty'), context.t('profilesLede'))}
    <dialog id="profile-dialog"><div class="dialog-head"><h2>${context.esc(context.t('createProfile'))}</h2><button class="button" data-action="close-dialog">${context.esc(context.t('cancel'))}</button></div><div class="dialog-body">${renderProfileForm(context)}</div></dialog>
  </section>`
}

export function renderProfileForm(context: ViewContext, profile?: JsonRecord) {
  const preferences = profile?.preferences ?? {}
  return `<form id="profile-form" class="form-grid" data-profile="${context.esc(profile?.slug ?? '')}">
    <div class="field"><label for="profile-slug">${context.esc(context.t('slug'))}</label><input id="profile-slug" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,63}" value="${context.esc(profile?.slug ?? '')}" ${profile ? 'disabled' : ''}></div>
    <div class="field"><label for="profile-label">${context.esc(context.t('label'))}</label><input id="profile-label" name="label" required maxlength="80" value="${context.esc(profile?.label ?? '')}"></div>
    <div class="field"><label for="profile-role">${context.esc(context.t('role'))}</label><input id="profile-role" name="roleLabel" maxlength="80" value="${context.esc(preferences.roleLabel ?? '')}"></div>
    <div class="field"><label for="profile-visibility">${context.esc(context.t('visibility'))}</label><select id="profile-visibility" name="browserVisibility">${['auto', 'headed', 'headless'].map((value) => `<option ${preferences.browserVisibility === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
    <fieldset class="field full"><legend>${context.esc(context.t('enabledProviders'))}</legend><div class="checks">${context.snapshot.providers.map((provider: JsonRecord) => `<label><input type="checkbox" name="enabledProviders" value="${context.esc(provider.id)}" ${!profile || preferences.enabledProviders?.includes(provider.id) ? 'checked' : ''}>${context.esc(provider.label)}</label>`).join('')}</div></fieldset>
    <div class="field full"><label for="profile-proxy">${context.esc(context.t('proxy'))}</label><input id="profile-proxy" name="proxy" placeholder="socks5://127.0.0.1:1080" value="${context.esc(preferences.proxy?.server ?? '')}"></div>
    <div class="field full"><label for="profile-bypass">${context.esc(context.t('proxyBypass'))}</label><input id="profile-bypass" name="proxyBypass" value="${context.esc(preferences.proxy?.bypass?.join(', ') ?? '')}"></div>
    <p class="secondary full">${context.esc(context.t('proxyRestartNote'))}</p>
    <div class="form-actions"><button class="button primary" type="submit">${context.esc(profile ? context.t('save') : context.t('create'))}</button></div>
  </form>`
}
