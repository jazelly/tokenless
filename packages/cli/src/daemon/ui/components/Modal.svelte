<script lang="ts">
  import { X } from '@lucide/svelte'

  let {
    title,
    closeLabel,
    onclose,
    wide = false,
    children,
  }: {
    title: string
    closeLabel: string
    onclose: () => void
    wide?: boolean
    children: import('svelte').Snippet
  } = $props()

  function backdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onclose()
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={backdropClick} onkeydown={(event) => event.key === 'Escape' && onclose()}>
  <div class:wide class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-testid="modal">
    <header class="modal-header">
      <h2 id="modal-title">{title}</h2>
      <button class="icon-button" type="button" aria-label={closeLabel} title={closeLabel} onclick={onclose} data-testid="modal-close">
        <X size={18} strokeWidth={1.8} />
      </button>
    </header>
    <div class="modal-body">{@render children()}</div>
  </div>
</div>
