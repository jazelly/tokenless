<script lang="ts">
  import ProviderCard from './ProviderCard.svelte'

  let { name = 'ChatGPT', slug = 'chatgpt', short = 'C', tint = '#7bd5b1', mode = 'Browser', status = 'Supported', initialEnabled = true } = $props<{
    name?: string
    slug?: string
    short?: string
    tint?: string
    mode?: string
    status?: string
    initialEnabled?: boolean
  }>()
  let enabled = $state(true)
  let previousInitialEnabled: boolean | undefined

  $effect(() => {
    if (initialEnabled !== previousInitialEnabled) {
      previousInitialEnabled = initialEnabled
      enabled = initialEnabled
    }
  })
</script>

<div class="provider-demo"><ProviderCard {name} {slug} {short} {tint} {mode} {status} {enabled} ontoggle={() => enabled = !enabled} /></div>

<style>
  .provider-demo { width: min(360px, calc(100vw - 40px)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
</style>
