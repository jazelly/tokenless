<script lang="ts">
  let {
    label,
    variant = 'secondary',
    disabled = false,
    onclick = () => {},
  }: {
    label: string
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    disabled?: boolean
    onclick?: () => void
  } = $props()
</script>

<button class={`action-button ${variant}`} type="button" {disabled} {onclick}>{label}</button>

<style>
  .action-button { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; padding: 0 14px; border: 1px solid var(--da-line, #dedcd6); border-radius: 8px; background: var(--da-surface, #fff); color: var(--da-ink, #171715); font: inherit; font-size: 12px; font-weight: 680; cursor: pointer; transition: transform 120ms ease, background 120ms ease, border-color 120ms ease; }
  .action-button:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in srgb, var(--da-ink, #171715) 28%, var(--da-line, #dedcd6)); }
  .action-button:focus-visible { outline: 2px solid var(--da-ink, #171715); outline-offset: 2px; }
  .primary { border-color: var(--da-ink, #171715); background: var(--da-ink, #171715); color: var(--da-surface, #fff); }
  .danger { border-color: #c94b43; color: #a92f28; }
  .ghost { border-color: transparent; background: transparent; }
  .action-button:disabled { cursor: not-allowed; opacity: .46; }
</style>
