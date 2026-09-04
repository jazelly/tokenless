<script lang="ts">
  import { onMount } from "svelte";
  import { Check, ChevronDown, UserRound } from "@lucide/svelte";

  type ProfileOption = {
    slug: string;
    label: string;
    description: string;
  };

  let {
    profiles,
    value,
    label,
    countLabel,
    onselect,
  }: {
    profiles: ProfileOption[];
    value: string;
    label: string;
    countLabel?: string;
    onselect: (slug: string) => void;
  } = $props();

  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let open = $state(false);
  let current = $derived(
    profiles.find((profile) => profile.slug === value) ?? profiles[0],
  );

  onMount(() => {
    const closeFromOutside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) open = false;
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  });

  function toggle() {
    open = !open;
    if (open)
      queueMicrotask(() =>
        root
          .querySelector<HTMLButtonElement>(`[data-profile="${value}"]`)
          ?.focus(),
      );
  }

  function choose(slug: string) {
    onselect(slug);
    open = false;
    queueMicrotask(() => trigger.focus());
  }

  function triggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) toggle();
    }
  }

  function optionKeydown(event: KeyboardEvent, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      open = false;
      trigger.focus();
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const options = root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options[(index + direction + options.length) % options.length]?.focus();
  }
</script>

<div bind:this={root} class:open class="profile-switcher">
  <button
    bind:this={trigger}
    class="profile-switcher-trigger hover-tooltip tooltip-below tooltip-right"
    type="button"
    data-testid="header-profile"
    aria-label={`${label}: ${current?.label ?? value}`}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
    onkeydown={triggerKeydown}
  >
    <span class="profile-switcher-icon"
        ><UserRound size={16} aria-hidden="true" /></span
      >
    <span class="profile-switcher-copy">
      <strong>{current?.label ?? value}</strong>
    </span>
    <span class="profile-switcher-chevron"><ChevronDown size={14} aria-hidden="true" /></span>
    {#if !open}
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{label}: {current?.label ?? value}{countLabel ? ` · ${countLabel}` : ''}</span>
    {/if}
  </button>

  {#if open}
    <div class="profile-switcher-menu" role="listbox" aria-label={label}>
      {#each profiles as profile, index (profile.slug)}
        <button
          class:selected={profile.slug === value}
          type="button"
          role="option"
          aria-selected={profile.slug === value}
          data-profile={profile.slug}
          onclick={() => choose(profile.slug)}
          onkeydown={(event) => optionKeydown(event, index)}
        >
          <span class="profile-option-avatar"
            >{profile.slug.slice(0, 1).toUpperCase()}</span
          >
          <span
            ><strong>{profile.label}</strong><small>{profile.description}</small
            ></span
          >
          {#if profile.slug === value}<Check size={15} />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .profile-switcher {
    align-self: center;
    position: relative;
    min-width: 0;
    width: clamp(96px, 14vw, 180px);
    color: var(--ink, #171715);
  }
  .profile-switcher-trigger {
    display: flex;
    width: 100%;
    height: 36px;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 130ms ease;
  }
  .profile-switcher-trigger:hover,
  .profile-switcher.open .profile-switcher-trigger {
    background: var(--surface-muted, #f0efec);
  }
  .profile-switcher-trigger:focus-visible {
    outline: 2px solid var(--ink, #171715);
    outline-offset: -3px;
  }
  .profile-switcher-icon {
    display: grid;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--muted, #706e68);
  }
  .profile-switcher-copy {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
  }
  .profile-switcher-copy strong {
    overflow: hidden;
    font-size: 14px;
    font-weight: 650;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-switcher-chevron {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    color: var(--muted, #706e68);
    transition: transform 150ms ease;
  }
  .open .profile-switcher-chevron {
    transform: rotate(180deg);
  }
  .profile-switcher-menu {
    position: absolute;
    z-index: 90;
    top: calc(100% + 7px);
    right: 0;
    width: min(248px, calc(100vw - 24px));
    overflow: hidden;
    padding: 6px;
    border: 1px solid var(--line, #dedcd6);
    border-radius: 12px;
    background: var(--surface, #fff);
    box-shadow:
      0 18px 48px rgb(24 23 20 / 18%),
      0 2px 8px rgb(24 23 20 / 8%);
  }
  .profile-switcher-menu button {
    display: grid;
    width: 100%;
    min-height: 54px;
    grid-template-columns: 32px minmax(0, 1fr) 18px;
    align-items: center;
    gap: 10px;
    padding: 7px 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .profile-switcher-menu button:hover,
  .profile-switcher-menu button:focus-visible,
  .profile-switcher-menu button.selected {
    background: var(--surface-muted, #f0efec);
    outline: 0;
  }
  .profile-switcher-menu button > span:nth-child(2) {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  .profile-switcher-menu strong {
    font-size: 12px;
    line-height: 1.2;
  }
  .profile-switcher-menu small {
    overflow: hidden;
    color: var(--muted, #706e68);
    font-size: 10px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-option-avatar {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 1px solid var(--line, #dedcd6);
    border-radius: 9px;
    background: var(--surface, #fff);
    font-size: 11px;
    font-weight: 750;
  }
  @media (max-width: 760px) {
    .profile-switcher { width: clamp(96px, 27vw, 150px); }
    .profile-switcher-trigger { gap: 6px; padding: 0 6px; }
  }
</style>
