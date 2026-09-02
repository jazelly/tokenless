<script lang="ts">
  import MetricCard from './MetricCard.svelte'

  let { label = 'Completed jobs', value = '24', detail = 'Selected range · Aug 4–Sep 2', icon = 'activity' } = $props<{
    label?: string
    value?: string
    detail?: string
    icon?: 'provider' | 'activity' | 'success' | 'capability'
  }>()
</script>

<div class="metric-demo"><MetricCard {label} {value} {detail} {icon} /></div>

<style>
  .metric-demo { width: min(300px, calc(100vw - 40px)); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
</style>
