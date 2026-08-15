<script lang="ts">
  import { Check, ChevronRight, Ellipsis, ExternalLink, Plus, Settings2, Star, Trash2, UserRound } from '@lucide/svelte'
  import { tick } from 'svelte'
  import Modal from '../components/Modal.svelte'
  import ProfileForm from '../components/ProfileForm.svelte'
  import { stateLabel, type MessageKey } from '../localization.js'
  import type {
    DashboardActions,
    Language,
    UiProfileCreate,
    UiProfileUpdate,
    UiProvider,
    UiSnapshot,
  } from '../types.js'

  let {
    snapshot,
    selectedProfile,
    language,
    t,
    busy,
    onselect,
    actions,
  }: {
    snapshot: UiSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey) => string
    busy: boolean
    onselect: (slug: string) => void
    actions: DashboardActions
  } = $props()

  let editorOpen = $state(false)
  let creating = $state(false)
  let deleteOpen = $state(false)
  let deleteConfirmation = $state('')
  let menuOpen = $state(false)
  let menuButton = $state<HTMLButtonElement>()
  let menuElement = $state<HTMLDivElement>()
  let actionContainer = $state<HTMLDivElement>()
  let profile = $derived(snapshot.profiles.find((entry) => entry.slug === selectedProfile) ?? snapshot.profiles[0]!)

  function openEditor(create = false) {
    creating = create
    editorOpen = true
    menuOpen = false
  }

  async function saveProfile(value: UiProfileCreate | UiProfileUpdate) {
    if (!('slug' in value) && !profile) return
    const result = 'slug' in value
      ? await actions.createProfile(value)
      : await actions.updateProfile(profile!.slug, value)
    editorOpen = false
    if ('slug' in value) onselect(result.slug)
  }

  async function removeProfile() {
    if (!profile || deleteConfirmation !== profile.slug) return
    try {
      await actions.removeProfile(profile.slug)
      deleteOpen = false
      deleteConfirmation = ''
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function openProfile(slug = profile?.slug) {
    if (!slug) return
    try {
      await actions.openProfile(slug)
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  function openListProfile(event: MouseEvent, slug: string) {
    event.stopPropagation()
    void openProfile(slug)
  }

  async function setDefault() {
    menuOpen = false
    try {
      await actions.updateProfile(profile.slug, { setDefault: true })
    } catch {
      // The shared mutation boundary already reports the error.
    }
  }

  async function toggleMenu() {
    menuOpen = !menuOpen
    if (menuOpen) {
      await tick()
      menuElement?.querySelector<HTMLButtonElement>('button')?.focus()
    } else {
      menuButton?.focus()
    }
  }

  function closeMenu() {
    if (!menuOpen) return
    menuOpen = false
    menuButton?.focus()
  }

  function menuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (!menuElement) return
    event.preventDefault()
    const items = [...menuElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  function outsidePointerDown(event: PointerEvent) {
    if (menuOpen && event.target instanceof Node && !actionContainer?.contains(event.target)) menuOpen = false
  }

  function stateFor(provider: UiProvider) {
    return provider.profiles.find((entry) => entry.profileId === profile?.slug)
  }
</script>

<svelte:window onpointerdown={outsidePointerDown} />

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
        <div class:active={entry.slug === profile?.slug} class="profile-list-row">
          <button
            class:active={entry.slug === profile?.slug}
            class="profile-list-item"
            type="button"
            onclick={() => onselect(entry.slug)}
            data-testid={`profile-item-${entry.slug}`}
          >
            <span class="avatar"><UserRound size={17} /></span>
            <span class="profile-list-copy">
              <strong>{entry.slug}</strong>
              <small>{entry.roleLabel || '—'}</small>
            </span>
            {#if entry.isDefault}<Star class="default-star" size={13} fill="currentColor" />{:else}<ChevronRight size={15} />{/if}
          </button>
          <button
            class="profile-list-open icon-button"
            type="button"
            aria-label={`${t('openBrowser')}: ${entry.slug}`}
            title={t('openBrowser')}
            disabled={busy}
            onclick={(event) => openListProfile(event, entry.slug)}
            data-testid={`open-profile-${entry.slug}`}
          >
            <ExternalLink size={15} />
          </button>
        </div>
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
              <h2>{profile.slug}</h2>
              {#if profile.isDefault}<span class="badge neutral">{t('default')}</span>{/if}
            </div>
          </div>
        </div>
        <div bind:this={actionContainer} class="inspector-actions">
          <button bind:this={menuButton} class="icon-button" type="button" aria-label={t('openMenu')} title={t('openMenu')} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="profile-actions-menu" onclick={toggleMenu} data-testid="profile-menu">
            <Ellipsis size={18} />
          </button>
          {#if menuOpen}
            <div bind:this={menuElement} id="profile-actions-menu" class="popover-menu" role="menu" tabindex="-1" onkeydown={menuKeydown} data-testid="profile-menu-popover">
              <button type="button" role="menuitem" onclick={() => openEditor()}><Settings2 size={15} />{t('edit')}</button>
              {#if !profile.isDefault}<button type="button" role="menuitem" onclick={setDefault}><Star size={15} />{t('setDefault')}</button>{/if}
              <button class="danger-text" type="button" role="menuitem" onclick={() => { deleteOpen = true; menuOpen = false }}><Trash2 size={15} />{t('deleteProfile')}</button>
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
            <div class="settings-row"><span>{t('slug')}</span><strong translate="no">{profile.slug}</strong></div>
            <div class="settings-row"><span>{t('role')}</span><strong>{profile.roleLabel || '—'}</strong></div>
            <div class="settings-row"><span>{t('profileBrowser')}</span><strong translate="no" data-testid="profile-browser-binding">{profile.browserBinding.browserId} · {profile.browserBinding.runtimeId}</strong></div>
            <div class="settings-row"><span>{t('visibility')}</span><strong>headed</strong></div>
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
                  <small>{state?.observation?.account?.name ?? (state?.observation?.access ? stateLabel(language, state.observation.access) : t('neverChecked'))}</small>
                </div>
                <span class:ok={state?.runtimeEligibility === 'eligible'} class="status-dot" aria-label={stateLabel(language, state?.runtimeEligibility ?? 'ineligible')}></span>
                {#if state?.enabled}<Check size={15} class="row-check" />{/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title"><h3>{t('connection')}</h3></div>
          <div class="settings-list">
            <div class="settings-row"><span>{t('status')}</span><strong class="status-value"><span class="status-dot ok"></span>{profile.lifecycle ? stateLabel(language, profile.lifecycle) : t('profileReady')}</strong></div>
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
        <input name="deleteConfirmation" bind:value={deleteConfirmation} autocomplete="off" spellcheck="false" data-testid="delete-confirmation" />
      </label>
      <div class="form-actions">
        <button class="button secondary" type="button" onclick={() => deleteOpen = false}>{t('cancel')}</button>
        <button class="button danger" type="button" disabled={busy || deleteConfirmation !== profile.slug} onclick={removeProfile} data-testid="delete-profile">{#if busy}<span class="spinner mini"></span>{/if}{t('remove')}</button>
      </div>
    </div>
  </Modal>
{/if}
