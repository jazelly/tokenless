<script lang="ts">
  import ProfileSwitcher from './ProfileSwitcher.svelte'

  let { initialValue = 'design', compact = false, startOpen = false } = $props<{
    initialValue?: string
    compact?: boolean
    startOpen?: boolean
  }>()

  const profiles = [
    { slug: 'design', label: 'design', description: 'UI review and product critique' },
    { slug: 'studio', label: 'studio', description: 'Writing, campaigns, and media work' },
    { slug: 'research', label: 'research', description: 'Evidence, synthesis, and comparison' },
    { slug: 'personal', label: 'personal', description: 'Everyday questions and quick tasks' },
  ]
  let value = $state('design')
  let previousInitialValue: string | undefined

  $effect(() => {
    if (initialValue !== previousInitialValue) {
      previousInitialValue = initialValue
      value = initialValue
    }
  })
</script>

<div class="component-demo-stage">
  <ProfileSwitcher {profiles} {value} label="Choose a profile" countLabel="4 Profiles" {compact} {startOpen} onselect={(slug) => value = slug} />
  <p>Current profile: <strong>{value}</strong></p>
</div>

<style>
  .component-demo-stage { width: min(420px, calc(100vw - 40px)); min-height: 260px; padding: 28px; border: 1px solid #dedcd6; border-radius: 14px; background: #fff; color: #171715; font: 13px Inter, ui-sans-serif, system-ui, sans-serif; }
  p { margin: 28px 0 0; color: #706e68; }
  strong { color: #171715; }
</style>
