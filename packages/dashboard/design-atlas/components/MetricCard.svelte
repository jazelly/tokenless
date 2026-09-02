<script lang="ts">
  import { Activity, CheckCircle2, Layers3 } from "@lucide/svelte";
  import UsersRoundIcon from "../UsersRoundIcon.svelte";

  let {
    label,
    value,
    detail,
    icon = "activity",
  }: {
    label: string;
    value: string;
    detail: string;
    icon?: "provider" | "activity" | "success" | "capability";
  } = $props();
</script>

<article class="atlas-card kpi-card" data-component="metric-card">
  <span class="kpi-icon">
    {#if icon === "provider"}<UsersRoundIcon />
    {:else if icon === "success"}<CheckCircle2 size={17} />
    {:else if icon === "capability"}<Layers3 size={17} />
    {:else}<Activity size={17} />{/if}
  </span>
  <small>{label}</small>
  <strong>{value}</strong>
  <p>{detail}</p>
</article>
