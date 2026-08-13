<script lang="ts">
  // STEREO EXPAND MENU — right-click a stereo jack → show its two L/R holes.
  //
  // Opened by Canvas from the bubbling `patchpanel:stereoexpand` event, for the
  // one right-click case that had NO menu at all: an UNPATCHED audio INPUT.
  // (A patched point already opens UnpatchMenu and an output already opens the
  // patch picker; both of those grew the same row rather than a second menu, so
  // the gesture reads identically wherever the user right-clicks.)
  //
  // Layout + dismissal are UnpatchMenu's, deliberately: body-portaled +
  // `position: fixed` so it escapes SvelteFlow's transformed viewport, placed by
  // the shared `clampMenu` action so a jack on the screen edge does not spill
  // the menu off-screen, and closed by Escape, a pointerdown in negative space,
  // or a pick.
  //
  // Presentation only. The caller owns the toggle (Canvas calls
  // `setJackExpanded`), exactly as it owns the unpatch removal — one seam.

  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Header — the patch point ("<Module> <JACK>"). */
    title: string;
    /** TRUE when the pair is currently shown as two rows, so the single row
     *  offers the way back. */
    expanded: boolean;
    /** The two leg labels, shown on the row so the user knows what appears
     *  ("CH1 L" / "CH1 R") before committing to the gesture. */
    legLabels: readonly [string, string];
    onchange: (expanded: boolean) => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    expanded,
    legLabels,
    onchange,
    onclose,
  }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);

  function pick(): void {
    onchange(!expanded);
    onclose();
  }

  $effect(() => {
    if (!open) return;
    // CAPTURE + stopPropagation, matching UnpatchMenu: Escape must close the
    // MENU ONLY, not the dock full-view drawer whose bubble-phase keymap would
    // otherwise also fire.
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onclose();
    }
    function onDown(e: PointerEvent) {
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      onclose();
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  });
</script>

{#if open}
  <div
    bind:this={menuEl}
    class="menu"
    use:portal
    use:clampMenu={{ x, y }}
    role="menu"
    tabindex="-1"
    aria-label="Stereo jack layout"
    data-testid="stereo-expand-menu"
  >
    <div class="head">{title}</div>
    <button
      class="row"
      type="button"
      role="menuitem"
      data-testid="stereo-expand-toggle"
      data-expanded={expanded ? 'true' : 'false'}
      onclick={pick}
    >
      {#if expanded}
        collapse to one stereo jack
      {:else}
        expand to {legLabels[0]} / {legLabels[1]}
      {/if}
    </button>
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 10000;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--border, #333);
    border-radius: 6px;
    background: var(--panel, #1b1b1b);
    box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
    font-size: 11px;
    color: var(--fg, #ddd);
  }

  .head {
    padding: 5px 8px 6px;
    border-bottom: 1px solid var(--border, #333);
    color: var(--fg-dim, #999);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .row {
    display: block;
    width: 100%;
    margin-top: 3px;
    padding: 6px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--accent-dim, #2c2c2c);
  }
</style>
