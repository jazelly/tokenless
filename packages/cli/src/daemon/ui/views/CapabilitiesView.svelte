<script lang="ts">
  import { ChevronRight, Layers3 } from '@lucide/svelte'
  import Modal from '../components/Modal.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { formatNumber } from '../formatting.js'
  import { capabilityFamilyLabel, capabilityText, stateLabel } from '../localization.js'
  import type { JsonRecord, Language } from '../types.js'

  let { snapshot, selectedProfile, language, t, onselect }: {
    snapshot: JsonRecord
    selectedProfile: string
    language: Language
    t: (key: any) => string
    onselect: (slug: string) => void
  } = $props()

  let selected = $state<JsonRecord | null>(null)
  let profile = $derived(snapshot.profiles.find((entry: JsonRecord) => entry.slug === selectedProfile) ?? snapshot.profiles[0])
  let groups = $derived(Object.entries(snapshot.capabilities.reduce((result: Record<string, JsonRecord[]>, capability: JsonRecord) => {
    ;(result[capability.family] ??= []).push(capability)
    return result
  }, {})) as [string, JsonRecord[]][])

  function providerSummary(capability: JsonRecord) {
    if (!capability.providers?.length) return t('noRoute')
    return capability.providers.map((route: JsonRecord) => {
      const provider = snapshot.providers.find((entry: JsonRecord) => entry.id === route.provider)
      const state = provider?.profiles?.find((entry: JsonRecord) => entry.profileId === profile?.slug)
      return `${route.provider} · ${stateLabel(language, state?.runtimeEligibility ?? 'ineligible')}`
    }).join(', ')
  }
</script>

<section class="page" data-testid="capabilities-view">
  <PageHeader title={t('capabilities')} description={t('capabilitiesLede')}>
    {#snippet actions()}
      <label class="inline-select"><span class="sr-only">{t('selectProfile')}</span><select name="capabilityProfile" value={profile?.slug} onchange={(event) => onselect(event.currentTarget.value)}>{#each snapshot.profiles as entry}<option value={entry.slug}>{entry.label}</option>{/each}</select></label>
    {/snippet}
  </PageHeader>

  <div class="capability-groups">
    {#each groups as [family, capabilities] (family)}
      <section class="capability-group">
        <header><h2>{capabilityFamilyLabel(language, family)}</h2><span>{formatNumber(capabilities.length, language)}</span></header>
        <div class="content-panel row-list">
          {#each capabilities as capability (capability.id)}
            {@const copy = capabilityText(language, capability)}
            <button class="data-row capability-row" type="button" onclick={() => selected = capability}>
              <span class="metric-icon"><Layers3 size={16} /></span>
              <span class="data-row-main"><strong>{copy.title}</strong><small>{copy.description}</small></span>
              <span class="badge neutral">{stateLabel(language, capability.stability)}</span>
              <span class="capability-route">{providerSummary(capability)}</span>
              <ChevronRight size={15} />
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</section>

{#if selected}
  {@const copy = capabilityText(language, selected)}
  <Modal title={copy.title} closeLabel={t('close')} onclose={() => selected = null} wide>
    <div class="detail-stack">
      <p>{copy.description}</p>
      <span class="badge neutral">{stateLabel(language, selected.stability)}</span>
      <section><h3>{t('evidence')}</h3><pre>{JSON.stringify({ required: selected.requiredEvidence, providers: selected.providers }, null, 2)}</pre></section>
    </div>
  </Modal>
{/if}
