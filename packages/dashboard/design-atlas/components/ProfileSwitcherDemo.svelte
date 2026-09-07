<script lang="ts">
  import ProfileSwitcher from '../../src/components/ProfileSwitcher.svelte'
  import { translate } from '../../src/i18n/index.js'
  import type { Language } from '../../src/types.js'
  import { createPreviewSnapshot } from '../preview-data.js'
  let { initialValue = 'design', language = 'en' }: {
    initialValue?: string; language?: Language
  } = $props()
  let value = $state('design')
  const profiles = $derived(createPreviewSnapshot(language).profiles.map(profile => ({ slug: profile.slug, label: profile.slug, description: profile.roleLabel })))
  $effect(() => { value = initialValue })
</script>
<div style="width:min(420px,calc(100vw - 40px));min-height:340px;padding:20px">
  <ProfileSwitcher {profiles} {value} label={translate(language, 'selectProfile')} countLabel={`4 ${translate(language, 'profiles')}`} onselect={(slug) => value = slug} />
</div>
