<script lang="ts">
  import ProviderModeBadges from '../../src/components/ProviderModeBadges.svelte'
  import { translate } from '../../src/i18n/index.js'
  import type { Language } from '../../src/types.js'
  import { createPreviewSnapshot } from '../preview-data.js'
  let { language = 'en', enabled = true }: { language?: Language; enabled?: boolean } = $props()
  const provider = $derived(createPreviewSnapshot(language).providers[0]!)
</script>
<ProviderModeBadges {provider} state={provider.profiles[enabled ? 0 : 2]} t={(key) => translate(language, key)} />
