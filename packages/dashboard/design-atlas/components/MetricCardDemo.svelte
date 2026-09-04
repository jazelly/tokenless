<script lang="ts">
  import MetricCard from '../../src/components/MetricCard.svelte'
  let props: import('svelte').ComponentProps<typeof MetricCard> = $props()
</script>
<div class="analytics-kpis" style="grid-template-columns:1fr;width:300px"><MetricCard {...props} /></div>
