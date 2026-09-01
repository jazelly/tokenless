<script lang="ts">
  let { provider, label = provider, compact = false }: { provider: string; label?: string; compact?: boolean } = $props()
</script>

<span class:compact class={`provider-identity provider-${provider}`} translate="no" title={label}>
  <span class="provider-identity-icon" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
  {#if !compact}<span>{label}</span>{/if}
</span>
