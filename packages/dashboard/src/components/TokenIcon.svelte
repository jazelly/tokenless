<script lang="ts">
  let { size = 16 }: { size?: number } = $props()
</script>

<!-- Product-specific token unit: a circled T with one short accounting bar. -->
<svg class="token-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="9" />
  <path d="M8 8h8M12 8v9M9.5 13h5" />
</svg>

<style>
  .token-icon { display: inline-block; flex: 0 0 auto; vertical-align: -.15em; }
</style>
