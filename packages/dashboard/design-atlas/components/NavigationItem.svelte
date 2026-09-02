<script lang="ts">
  import { Blocks, LayoutDashboard, MessageSquareText, PanelsTopLeft, Settings, UsersRound } from '@lucide/svelte'

  let {
    label,
    icon = 'overview',
    active = false,
    compact = false,
    onclick = () => {},
  }: {
    label: string
    icon?: 'overview' | 'profiles' | 'providers' | 'capabilities' | 'history' | 'system'
    active?: boolean
    compact?: boolean
    onclick?: () => void
  } = $props()
</script>

<button class:active class:compact class="navigation-item" type="button" {onclick}>
  {#if icon === 'profiles'}<UsersRound size={17} />
  {:else if icon === 'providers'}<PanelsTopLeft size={17} />
  {:else if icon === 'capabilities'}<Blocks size={17} />
  {:else if icon === 'history'}<MessageSquareText size={17} />
  {:else if icon === 'system'}<Settings size={17} />
  {:else}<LayoutDashboard size={17} />{/if}
  <span>{label}</span>
</button>

<style>
  .navigation-item { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 11px; padding: 0 11px; border: 0; border-radius: 7px; background: transparent; color: var(--da-muted, #706e68); font: inherit; font-size: 12px; font-weight: 620; text-align: left; cursor: pointer; }
  .navigation-item:hover { background: var(--da-accent-soft, #f0efec); color: var(--da-ink, #171715); }
  .navigation-item.active { background: var(--da-ink, #171715); color: var(--da-surface, #fff); }
  .navigation-item:focus-visible { outline: 2px solid var(--da-ink, #171715); outline-offset: 2px; }
  .compact { width: 64px; min-height: 56px; flex-direction: column; justify-content: center; gap: 4px; padding: 4px; font-size: 9px; }
</style>
