<script lang="ts">
  import { onMount } from 'svelte'
  import type { DashboardClient } from '../dashboard-client.js'
  import type { MessageKey } from '../i18n/index.js'
  import type { HarnessExtensionPairingRequest, DashboardSnapshot } from '../types.js'
  import Modal from './Modal.svelte'

  let { client, pairingId, snapshot, selectedProfile, t, onclose, onapproved }: {
    client: DashboardClient
    pairingId: string
    snapshot: DashboardSnapshot
    selectedProfile: string
    t: (key: MessageKey) => string
    onclose: () => void
    onapproved: () => void
  } = $props()

  let request = $state<HarnessExtensionPairingRequest | null>(null)
  let profileId = $state('')
  let provider = $state('')
  let busy = $state(false)
  let error = $state('')
  let approved = $state(false)
  let profile = $derived(snapshot.profiles.find((entry) => entry.slug === profileId))
  let providers = $derived(snapshot.providers.filter((entry) => profile?.enabledProviders.includes(entry.id)))

  $effect(() => {
    if (!providers.some((entry) => entry.id === provider)) provider = providers[0]?.id ?? ''
  })

  onMount(async () => {
    profileId = snapshot.profiles.find((profile) => profile.slug === selectedProfile)?.slug
      ?? snapshot.profiles.find((profile) => profile.isDefault)?.slug
      ?? snapshot.profiles[0]?.slug
      ?? ''
    try {
      request = await client.getHarnessExtensionPairing(pairingId)
      approved = request.state === 'approved'
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
    }
  })

  async function approve() {
    if (!profileId || !provider || busy) return
    busy = true
    error = ''
    try {
      await client.approveHarnessExtensionPairing(pairingId, { profileId, provider })
      approved = true
      onapproved()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : t('requestFailed')
    } finally {
      busy = false
    }
  }
</script>

<Modal title={t('harnessExtensionPairing')} closeLabel={t('close')} {onclose}>
  <div class="form-stack" data-testid="harness-extension-pairing">
    {#if error}<p class="danger-note" role="alert">{error}</p>{/if}
    {#if !request && !error}
      <p>{t('loading')}</p>
    {:else if request}
      <p>{t('harnessExtensionPairingLede')}</p>
      <dl class="detail-list">
        <div><dt>{t('harnessExtensionIdentity')}</dt><dd class="mono-label">{request.extensionId}</dd></div>
        <div><dt>{t('version')}</dt><dd>{request.extensionVersion}</dd></div>
        <div><dt>{t('harnessExtensionOrigin')}</dt><dd class="mono-label">chrome-extension://{request.extensionId}</dd></div>
      </dl>
      <p class="muted">{t('harnessExtensionScope')}</p>

      {#if approved}
        <p class="success-note" role="status">{t('harnessExtensionApproved')}</p>
        <button class="button primary" type="button" onclick={onclose}>{t('close')}</button>
      {:else}
        <label class="field">
          <span>{t('profile')}</span>
          <select name="harnessExtensionProfile" bind:value={profileId} disabled={busy}>
            {#each snapshot.profiles as entry (entry.slug)}<option value={entry.slug}>{entry.slug}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t('provider')}</span>
          <select name="harnessExtensionProvider" bind:value={provider} disabled={busy || providers.length === 0}>
            {#each providers as entry (entry.id)}<option value={entry.id}>{entry.label}</option>{/each}
          </select>
          {#if providers.length === 0}<small>{t('noEnabledProviders')}</small>{/if}
        </label>
        <button class="button primary" type="button" disabled={busy || !provider || !profileId} onclick={approve}>
          {busy ? t('harnessExtensionApproving') : t('harnessExtensionApprove')}
        </button>
      {/if}
    {/if}
  </div>
</Modal>
