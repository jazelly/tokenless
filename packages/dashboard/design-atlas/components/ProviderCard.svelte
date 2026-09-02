<script lang="ts">
  import { ArrowUpRight, Globe2 } from '@lucide/svelte'

  let {
    name,
    slug,
    short,
    tint = '#d8d6d0',
    mode = 'Browser',
    enabled = true,
    status = 'Supported',
    ontoggle = () => {},
  }: {
    name: string
    slug: string
    short: string
    tint?: string
    mode?: string
    enabled?: boolean
    status?: string
    ontoggle?: () => void
  } = $props()
</script>

<article class:disabled={!enabled} class="provider-card-component">
  <header>
    <span class="provider-mark" style={`--provider-tint:${tint}`}>{short}</span>
    <span class="provider-copy"><strong>{name}</strong><small>{slug}</small></span>
    <button class:active={enabled} type="button" aria-label={`${name} enabled`} aria-pressed={enabled} onclick={ontoggle}><i></i></button>
  </header>
  <div class="provider-meta"><span><Globe2 size={12} />{mode}</span><span>{status}</span></div>
  <footer><span>{enabled ? 'Ready' : 'Disabled'}</span><ArrowUpRight size={15} /></footer>
</article>

<style>
  .provider-card-component { width: 100%; min-width: 240px; overflow: hidden; border: 1px solid var(--da-line, #dedcd6); border-radius: 10px; background: var(--da-surface, #fff); color: var(--da-ink, #171715); }
  header { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 14px; }
  .provider-mark { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 10px; background: color-mix(in srgb, var(--provider-tint) 24%, white); font-size: 12px; font-weight: 800; }
  .provider-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  .provider-copy strong { font-size: 13px; }
  .provider-copy small { color: var(--da-muted, #706e68); font-size: 10px; }
  header button { position: relative; width: 31px; height: 18px; border: 0; border-radius: 999px; background: #cbc9c3; cursor: pointer; }
  header button i { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform 140ms ease; }
  header button.active { background: var(--da-ink, #171715); }
  header button.active i { transform: translateX(13px); }
  .provider-meta, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border-top: 1px solid var(--da-line-soft, #ebe9e4); color: var(--da-muted, #706e68); font-size: 10px; }
  .provider-meta span:first-child { display: inline-flex; align-items: center; gap: 5px; }
  footer { color: var(--da-ink, #171715); font-weight: 680; }
  .disabled { opacity: .62; }
</style>
