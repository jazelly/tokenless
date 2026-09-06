<script lang="ts">
  import TokenIcon from './TokenIcon.svelte'
  import { translate } from '../i18n/index.js'
  import type { Language } from '../types.js'
  let { language, size = 16 }: { language: Language; size?: number } = $props()
</script>

<button type="button" class="token-unit hover-tooltip tooltip-below" aria-label={translate(language, 'tokenUnitHelp')}>
  <TokenIcon {size} />
  <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{translate(language, 'tokenUnitHelp')}</span>
</button>

<style>
  .token-unit { --tooltip-x: 0; position: static; display: inline-flex; align-items: center; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: help; }
  .token-unit > .hover-tooltip-content { left: 0; width: 260px; max-width: calc(100vw - 72px); letter-spacing: normal; }
</style>
