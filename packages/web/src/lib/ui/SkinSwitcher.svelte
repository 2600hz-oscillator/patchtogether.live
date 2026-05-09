<script lang="ts">
  // SkinSwitcher — dropdown that lists every in-tree skin and lets the
  // user pick one. Mounts in Canvas.svelte's topbar `.actions` immediately
  // before the Sign in link.
  //
  // Visual: a pill button labelled with the active skin's name + a chevron;
  // click toggles a popover anchored under the button. Each row in the
  // popover shows the skin name + a 4-dot swatch (bg / accent / cable-audio
  // / cable-pitch) so the user previews the palette without committing.
  //
  // Keyboard: button is real <button>, popover items are real <button>s,
  // Esc closes (handled at the popover root). Click-outside closes via a
  // capture-phase pointerdown listener.
  import { onMount } from 'svelte';
  import { skinStore } from '$lib/ui/skins/skin-store.svelte';
  import { swatchColorsFor, type Skin } from '$lib/ui/skins';

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popoverEl: HTMLDivElement | null = $state(null);

  let current = $derived(skinStore.currentSkin);
  let skins = $derived(skinStore.list());

  function toggle() {
    open = !open;
  }
  function pick(s: Skin) {
    skinStore.setSkin(s.id);
    open = false;
    // Return focus to the trigger so keyboard users land somewhere
    // sensible after the popover closes.
    triggerEl?.focus();
  }

  // Close on outside click. We use pointerdown so the close lands BEFORE
  // a click on a sibling button fires (e.g., Sign in next door); without
  // capture-phase ordering, clicking the trigger to close + a click on
  // a different popover-anchored thing would race.
  onMount(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!open) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (popoverEl && popoverEl.contains(t)) return;
      if (triggerEl && triggerEl.contains(t)) return;
      open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        open = false;
        triggerEl?.focus();
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="skin-switcher">
  <button
    bind:this={triggerEl}
    type="button"
    class="trigger"
    data-testid="skin-switcher-trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggle}
  >
    <span class="dot" style:background={current.vars['--accent']} aria-hidden="true"></span>
    <span class="trigger-label" data-testid="skin-current-label">{current.label}</span>
    <span class="chevron" aria-hidden="true">▾</span>
    <!-- Hidden id mirror so e2e can assert the active skin id without
         parsing the dropdown. The label can be localized; the id is the
         contract. -->
    <span class="visually-hidden" data-testid="skin-current-id">{current.id}</span>
  </button>

  {#if open}
    <div
      bind:this={popoverEl}
      class="popover"
      role="listbox"
      aria-label="Choose a skin"
      data-testid="skin-switcher-popover"
    >
      {#each skins as s (s.id)}
        {@const swatches = swatchColorsFor(s)}
        <button
          type="button"
          class="option"
          class:active={current.id === s.id}
          role="option"
          aria-selected={current.id === s.id}
          data-testid="skin-option-{s.id}"
          onclick={() => pick(s)}
        >
          <span class="swatches" aria-hidden="true">
            {#each swatches as c, i (i)}
              <span class="swatch" style:background={c}></span>
            {/each}
          </span>
          <span class="option-text">
            <span class="option-label">{s.label}</span>
            <span class="option-desc">{s.description}</span>
          </span>
          {#if current.id === s.id}
            <span class="check" aria-hidden="true">✓</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .skin-switcher {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    border-color: var(--accent);
    color: var(--text);
  }
  .trigger:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--border-strong);
  }
  .trigger-label {
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .chevron {
    color: var(--text-dim);
    font-size: 0.7rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 220px;
    background: var(--module-bg);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 200;
  }
  .option {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.6rem;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text);
    text-align: left;
    padding: 6px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .option:hover,
  .option:focus-visible {
    background: var(--surface-2);
    outline: none;
  }
  .option.active {
    border-color: var(--accent-dim);
  }
  .swatches {
    display: inline-grid;
    grid-template-columns: repeat(2, 8px);
    grid-template-rows: repeat(2, 8px);
    gap: 1px;
    border: 1px solid var(--border-strong);
    border-radius: 2px;
    padding: 1px;
  }
  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
  }
  .option-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .option-label {
    font-weight: 500;
    color: var(--text);
  }
  .option-desc {
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .check {
    color: var(--accent);
    font-weight: 600;
  }
</style>
