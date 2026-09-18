<script lang="ts">
  import { onMount } from 'svelte'
  import { SlidersHorizontal } from '@lucide/svelte'
  import type { MessageKey } from '../i18n/index.js'
  import type { Language } from '../types.js'

  let {
    language,
    outputSavingsEnabled,
    busy,
    t,
    onlanguage,
    ontoggleoutputsavings,
  }: {
    language: Language
    outputSavingsEnabled: boolean
    busy: boolean
    t: (key: MessageKey) => string
    onlanguage: (language: Language) => Promise<void>
    ontoggleoutputsavings: () => Promise<void>
  } = $props()

  let root: HTMLDivElement
  let trigger: HTMLButtonElement
  let open = $state(false)

  onMount(() => {
    const closeFromOutside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) open = false
    }
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      open = false
      trigger.focus()
    }
    document.addEventListener('pointerdown', closeFromOutside)
    document.addEventListener('keydown', closeFromEscape)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside)
      document.removeEventListener('keydown', closeFromEscape)
    }
  })

  function toggle() {
    open = !open
  }

  async function chooseLanguage(next: Language) {
    if (next === language || busy) return
    try { await onlanguage(next) } catch { /* shared mutation boundary reports the error */ }
  }

  async function toggleOutputSavings() {
    if (busy) return
    try { await ontoggleoutputsavings() } catch { /* shared mutation boundary reports the error */ }
  }
</script>

<div bind:this={root} class:open class="quick-settings">
  <button
    bind:this={trigger}
    class="top-header-control quick-settings-trigger hover-tooltip tooltip-below tooltip-right"
    type="button"
    data-testid="quick-settings-trigger"
    aria-label={t('quickSettings')}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls="quick-settings-panel"
    onclick={toggle}
  >
    <SlidersHorizontal size={16} aria-hidden="true" />
    {#if !open}<span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{t('quickSettings')}</span>{/if}
  </button>

  {#if open}
    <div id="quick-settings-panel" class="quick-settings-panel" role="dialog" aria-labelledby="quick-settings-title" tabindex="-1" data-testid="quick-settings-panel">
      <header>
        <strong id="quick-settings-title">{t('quickSettings')}</strong>
        <small>{t('quickSettingsHelp')}</small>
      </header>

      <div class="quick-settings-row">
        <span>{t('language')}</span>
        <div class="language-options" role="group" aria-label={t('language')}>
          <button type="button" class:active={language === 'en'} aria-pressed={language === 'en'} disabled={busy} onclick={() => chooseLanguage('en')}>English</button>
          <button type="button" class:active={language === 'zh-CN'} aria-pressed={language === 'zh-CN'} disabled={busy} onclick={() => chooseLanguage('zh-CN')}>简体中文</button>
        </div>
      </div>

      <button
        class="quick-settings-toggle"
        type="button"
        role="switch"
        aria-checked={outputSavingsEnabled}
        disabled={busy}
        data-testid="quick-output-savings"
        onclick={toggleOutputSavings}
      >
        <span><strong>{t('outputSavings')}</strong><small>{t(outputSavingsEnabled ? 'savingsEnabled' : 'savingsDisabled')}</small></span>
        <i aria-hidden="true"><span></span></i>
      </button>
    </div>
  {/if}
</div>

<style>
  .quick-settings { position: relative; flex: 0 0 auto; }
  .quick-settings-trigger { border: 0; background: transparent; color: inherit; }
  .quick-settings.open .quick-settings-trigger { background: var(--surface-muted); }
  .quick-settings-panel {
    position: absolute;
    z-index: 90;
    top: calc(100% + 7px);
    right: 0;
    width: min(292px, calc(100vw - 24px));
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 18px 48px rgb(24 23 20 / 18%), 0 2px 8px rgb(24 23 20 / 8%);
  }
  .quick-settings-panel > header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 15px 16px 13px;
    border-bottom: 1px solid var(--line-soft);
  }
  .quick-settings-panel > header strong { font-size: 13px; }
  .quick-settings-panel > header small { line-height: 1.4; }
  .quick-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border-bottom: 1px solid var(--line-soft); }
  .quick-settings-row > span { color: var(--muted); font-size: 12px; font-weight: 600; }
  .language-options { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--canvas); }
  .language-options button { min-height: 28px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); font-size: 11px; font-weight: 650; }
  .language-options button:hover:not(:disabled) { color: var(--ink); }
  .language-options button.active { background: var(--surface); box-shadow: 0 1px 3px rgb(24 23 20 / 12%); color: var(--ink); }
  .quick-settings-toggle { display: flex; width: 100%; min-height: 64px; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 14px; border: 0; background: transparent; color: inherit; text-align: left; }
  .quick-settings-toggle:hover:not(:disabled) { background: var(--surface-muted); }
  .quick-settings-toggle > span { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
  .quick-settings-toggle strong { font-size: 12px; }
  .quick-settings-toggle small { overflow: hidden; font-size: 10px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
  .quick-settings-toggle > i { display: flex; width: 32px; height: 18px; flex: 0 0 auto; align-items: center; padding: 2px; border-radius: 999px; background: var(--subtle); transition: background 140ms ease; }
  .quick-settings-toggle > i > span { width: 14px; height: 14px; border-radius: 50%; background: white; box-shadow: 0 1px 3px rgb(24 23 20 / 24%); transition: transform 140ms ease; }
  .quick-settings-toggle[aria-checked="true"] > i { background: var(--green); }
  .quick-settings-toggle[aria-checked="true"] > i > span { transform: translateX(14px); }
  @media (max-width: 760px) {
    .quick-settings-panel { position: fixed; top: calc(62px + env(safe-area-inset-top)); right: 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .quick-settings-toggle > i, .quick-settings-toggle > i > span { transition: none; }
  }
</style>
