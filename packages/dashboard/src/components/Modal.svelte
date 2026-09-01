<script lang="ts">
  import { X } from '@lucide/svelte'
  import { onMount } from 'svelte'

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

  let closeButton: HTMLButtonElement
  let modalElement: HTMLDivElement

  onMount(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.focus()
    return () => previousFocus?.focus()
  })

  function backdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onclose()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...modalElement.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute('hidden'))
    if (!focusable.length) {
      event.preventDefault()
      return
    }
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={backdropClick} onkeydown={handleKeydown}>
  <div bind:this={modalElement} class:wide class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-testid="modal">
    <header class="modal-header">
      <h2 id="modal-title">{title}</h2>
      <button bind:this={closeButton} class="icon-button" type="button" aria-label={closeLabel} title={closeLabel} onclick={onclose} data-testid="modal-close">
        <X size={18} strokeWidth={1.8} />
      </button>
    </header>
    <div class="modal-body">{@render children()}</div>
  </div>
</div>
