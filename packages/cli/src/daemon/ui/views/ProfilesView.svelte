<script lang="ts">
  import { Check, ChevronRight, Ellipsis, ExternalLink, Plus, Settings2, Star, Trash2, UserRound } from '@lucide/svelte'
  import Modal from '../components/Modal.svelte'
  import ProfileForm from '../components/ProfileForm.svelte'
  import type { JsonRecord } from '../types.js'

  let {
    snapshot,
    selectedProfile,
    t,
    busy,
    onselect,
    onmutate,
  }: {
    snapshot: JsonRecord
    selectedProfile: string
    t: (key: any) => string
    busy: boolean
    onselect: (slug: string) => void
    onmutate: (path: string, body?: unknown, method?: string) => Promise<unknown>
  } = $props()

  let editorOpen = $state(false)
  let creating = $state(false)
  let deleteOpen = $state(false)
  let deleteConfirmation = $state('')
  let menuOpen = $state(false)
  let profile = $derived(snapshot.profiles.find((entry: JsonRecord) => entry.slug === selectedProfile) ?? snapshot.profiles[0])

  function openEditor(create = false) {
    creating = create
    editorOpen = true
    menuOpen = false
  }

  async function saveProfile(value: JsonRecord) {
    const result = await onmutate(
      creating ? '/profiles' : `/profiles/${encodeURIComponent(profile.slug)}`,
      value,
      creating ? 'POST' : 'PATCH',
    ) as JsonRecord
    editorOpen = false
    if (creating && result?.slug) onselect(String(result.slug))
  }

  async function removeProfile() {
    if (!profile || deleteConfirmation !== profile.slug) return
    await onmutate(`/profiles/${encodeURIComponent(profile.slug)}`, undefined, 'DELETE')
    deleteOpen = false
    deleteConfirmation = ''
  }

  function stateFor(provider: JsonRecord) {
    return provider.profiles?.find((entry: JsonRecord) => entry.profileId === profile?.slug)
  }
</script>

<section class="profiles-layout" data-testid="profiles-view">
  <aside class="profile-master" aria-label={t('profileList')}>
    <header class="profile-master-header">
      <div>
        <p class="eyebrow">Tokenless</p>
        <h1>{t('profiles')}</h1>
      </div>
      <button class="icon-button dark" type="button" aria-label={t('addProfile')} title={t('addProfile')} onclick={() => openEditor(true)} data-testid="add-profile">
        <Plus size={17} />
      </button>
    </header>
    <div class="profile-master-list">
      {#each snapshot.profiles as entry (entry.slug)}
        <button
          class:active={entry.slug === profile?.slug}
          class="profile-list-item"
          type="button"
          onclick={() => onselect(entry.slug)}
          data-testid={`profile-item-${entry.slug}`}
        >
          <span class="avatar"><UserRound size={17} /></span>
          <span class="profile-list-copy">
            <strong>{entry.label}</strong>
            <small>{entry.preferences?.roleLabel || entry.slug}</small>
          </span>
          {#if entry.isDefault}<Star class="default-star" size={13} fill="currentColor" />{:else}<ChevronRight size={15} />{/if}
        </button>
      {/each}
    </div>
    <p class="profile-master-note">{t('cleanProfileNote')}</p>
  </aside>

  {#if profile}
    <div class="profile-inspector">
      <header class="inspector-header">
        <div class="inspector-title">
          <span class="avatar large"><UserRound size={23} /></span>
          <div>
            <div class="title-line">
              <h2>{profile.label}</h2>
              {#if profile.isDefault}<span class="badge neutral">{t('default')}</span>{/if}
            </div>
            <p>{profile.slug}</p>
          </div>
        </div>
        <div class="inspector-actions">
          <button class="button secondary icon-label" type="button" onclick={() => onmutate(`/profiles/${encodeURIComponent(profile.slug)}/open`)} data-testid="open-profile">
            <ExternalLink size={15} /> <span>{t('open')}</span>
          </button>
          <button class="icon-button" type="button" aria-label={t('openMenu')} title={t('openMenu')} onclick={() => menuOpen = !menuOpen} data-testid="profile-menu">
            <Ellipsis size={18} />
          </button>
          {#if menuOpen}
            <div class="popover-menu" data-testid="profile-menu-popover">
              <button type="button" onclick={() => openEditor()}><Settings2 size={15} />{t('edit')}</button>
              {#if !profile.isDefault}<button type="button" onclick={() => onmutate(`/profiles/${encodeURIComponent(profile.slug)}`, { setDefault: true }, 'PATCH')}><Star size={15} />{t('setDefault')}</button>{/if}
              <button class="danger-text" type="button" onclick={() => { deleteOpen = true; menuOpen = false }}><Trash2 size={15} />{t('deleteProfile')}</button>
            </div>
          {/if}
        </div>
      </header>

      <div class="inspector-content">
        <section class="settings-section">
          <div class="settings-section-title">
            <h3>{t('profile')}</h3>
            <button class="text-button" type="button" onclick={() => openEditor()}>{t('edit')}</button>
          </div>
          <div class="settings-list">
            <div class="settings-row"><span>{t('label')}</span><strong>{profile.label}</strong></div>
            <div class="settings-row"><span>{t('role')}</span><strong>{profile.preferences?.roleLabel || '—'}</strong></div>
            <div class="settings-row"><span>{t('profileBrowser')}</span><strong>{profile.runtimeBinding?.browserId ?? snapshot.config.browser}</strong></div>
            <div class="settings-row"><span>{t('visibility')}</span><strong>{profile.preferences?.browserVisibility ?? 'auto'}</strong></div>
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title">
            <h3>{t('providersShort')}</h3>
            <button class="text-button" type="button" onclick={() => openEditor()}>{t('edit')}</button>
          </div>
          <div class="provider-settings-list">
            {#each snapshot.providers as provider (provider.id)}
              {@const state = stateFor(provider)}
              <div class:disabled={!state?.enabled} class="provider-setting-row">
                <div class="provider-glyph">{provider.label.slice(0, 1)}</div>
                <div>
                  <strong>{provider.label}</strong>
                  <small>{state?.observation?.account?.name ?? state?.observation?.access ?? t('neverChecked')}</small>
                </div>
                <span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot" aria-label={state?.runtimeEligibility ?? 'ineligible'}></span>
                {#if state?.enabled}<Check size={15} class="row-check" />{/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title"><h3>{t('connection')}</h3></div>
          <div class="settings-list">
            <div class="settings-row"><span>{t('proxy')}</span><strong>{profile.preferences?.proxy?.server ?? t('none')}</strong></div>
            <div class="settings-row"><span>{t('status')}</span><strong class="status-value"><span class="status-dot ok"></span>{profile.lifecycle ?? t('profileReady')}</strong></div>
          </div>
        </section>
      </div>
    </div>
  {/if}
</section>

{#if editorOpen}
  <Modal title={creating ? t('createProfile') : t('edit')} closeLabel={t('close')} onclose={() => editorOpen = false} wide>
    <ProfileForm snapshot={snapshot} profile={creating ? undefined : profile} {t} {busy} oncancel={() => editorOpen = false} onsubmit={saveProfile} />
  </Modal>
{/if}

{#if deleteOpen}
  <Modal title={t('deleteProfile')} closeLabel={t('close')} onclose={() => deleteOpen = false}>
    <div class="form-stack">
      <p class="danger-note">{t('deleteWarning')}</p>
      <label class="field">
        <span>{t('confirmDelete')} <strong>{profile.slug}</strong></span>
        <input bind:value={deleteConfirmation} autocomplete="off" data-testid="delete-confirmation" />
      </label>
      <div class="form-actions">
        <button class="button secondary" type="button" onclick={() => deleteOpen = false}>{t('cancel')}</button>
        <button class="button danger" type="button" disabled={busy || deleteConfirmation !== profile.slug} onclick={removeProfile} data-testid="delete-profile">{t('remove')}</button>
      </div>
    </div>
  </Modal>
{/if}
