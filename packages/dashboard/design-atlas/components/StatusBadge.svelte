<script lang="ts">
  let {
    label,
    tone = 'neutral',
    dot = false,
  }: {
    label: string
    tone?: 'neutral' | 'success' | 'warning' | 'danger'
    dot?: boolean
  } = $props()
</script>

<span class={`status-badge-component ${tone}`}>{#if dot}<i></i>{/if}{label}</span>

<style>
  .status-badge-component { display: inline-flex; min-height: 24px; align-items: center; gap: 6px; padding: 0 9px; border: 1px solid var(--da-line, #dedcd6); border-radius: 999px; background: var(--da-accent-soft, #f0efec); color: var(--da-muted, #706e68); font-size: 10px; font-weight: 700; white-space: nowrap; }
  i { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
  .success { border-color: #b9dcca; background: #eff8f3; color: #257451; }
  .warning { border-color: #e6cfaa; background: #fbf5e9; color: #96621d; }
  .danger { border-color: #ebc2be; background: #fdf1f0; color: #aa352d; }
</style>
