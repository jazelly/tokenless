<script lang="ts">
  import { Activity, CheckCircle2, Layers3, UsersRound } from '@lucide/svelte'
  let { label, value, detail, icon = 'activity' }: {
    label: string
    value: string
    detail: string
    icon?: 'provider' | 'activity' | 'success' | 'capability'
  } = $props()
</script>

<article>
  <span class="analytics-kpi-icon" data-metric={icon}>
    {#if icon === 'provider'}<UsersRound size={17} />
    {:else if icon === 'success'}<CheckCircle2 size={17} />
    {:else if icon === 'capability'}<Layers3 size={17} />
    {:else}<Activity size={17} />{/if}
  </span>
  <small>{label}</small><strong>{value}</strong><p>{detail}</p>
</article>
