<script lang="ts">
  import Dashboard from '../src/Dashboard.svelte'
  import type { Section } from '../src/types.js'
  import type { DesignAtlasArgs, DesignScreen } from './atlas-types.js'
  import { createPreviewState } from './preview-state.svelte.js'

  let {
    screen = 'overview', language = 'en', selectedProfile = 'design',
    backgroundColor = '#f6f5f2', surfaceColor = '#ffffff', textColor = '#171715',
    radius = 10, designState = 'ready',
  }: DesignAtlasArgs = $props()

  const preview = $derived(createPreviewState(language, designState, screen === 'setup'))
  let activeScreen = $state<DesignScreen>('overview')
  let activeProfile = $state('design')
  $effect(() => { activeScreen = screen })
  $effect(() => { activeProfile = selectedProfile })

  function navigate(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[data-dashboard-section]')
    if (!anchor) return
    event.preventDefault()
    activeScreen = anchor.dataset.dashboardSection as DesignScreen
  }
</script>

<div style={`--canvas:${backgroundColor};--surface:${surfaceColor};--ink:${textColor};--radius:${radius}px`}>
  {#key `${screen}:${language}:${designState}`}
    <Dashboard
      snapshot={activeScreen === 'loading' ? null : preview.snapshot}
      {language}
      section={(['setup', 'offline', 'fatal', 'loading'].includes(activeScreen) ? 'overview' : activeScreen) as Section}
      selectedProfile={activeProfile}
      actions={preview.actions}
      busy={designState === 'busy'}
      offline={activeScreen === 'offline'}
      fatal={activeScreen === 'fatal' ? (language === 'en' ? 'The Dashboard session has expired.' : 'Dashboard 会话已过期。') : ''}
      setupRoute={activeScreen === 'setup'}
      toast={preview.toast}
      sectionHref={(section) => `#${section}`}
      onselect={(slug) => activeProfile = slug}
      onsetup={async (input) => {
        await preview.actions.createProfile(input)
        activeProfile = input.slug
        activeScreen = 'profiles'
      }}
      ontoast={preview.notify}
    />
  {/key}
</div>

<svelte:window onclick={navigate} />
