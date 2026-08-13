<script lang="ts">
  // THE WIDTH-MISMATCH CHOOSER — "which side did you mean?"
  //
  // Opened by Canvas the moment a drop's two ends disagree about width: a MONO
  // source on a STEREO jack (L / R / both) or a STEREO source on a MONO jack
  // (which channel). Owner, 2026-08-12 — it replaces the silent double-patch,
  // so this menu is not an extra confirmation on top of the old behaviour, it
  // is where the decision now lives.
  //
  // QUICK AND UNOBTRUSIVE, which is a constraint and not a wish. It is the same
  // body-portaled `position: fixed` + `clampMenu` anchored popover as
  // StereoExpandMenu and UnpatchMenu — NOT a modal, no backdrop, no focus trap,
  // nothing to dismiss twice. It lands at the cursor, one keystroke or one
  // click resolves it, and Escape / a pointerdown in negative space CANCELS the
  // patch outright (no edge is written by any dismissal that is not a pick).
  //
  // WHY IT CAN AFFORD TO SAY WHAT IT COSTS. Each row carries the exact edges it
  // would evict, computed by `planDropChoice` from the SAME `planAudioCommit`
  // call that will commit it. So "replaces" is not a warning someone remembered
  // to add — it is the plan, rendered. This is the surfacing half of the
  // destructive-drop fix: dropping a second source on a patched stereo jack
  // used to take both legs of the live cable with no notice.
  //
  // Presentation only. Canvas owns the commit, exactly as it owns the unpatch
  // removal and the expand toggle — one seam.

  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
  import type { ChannelMode } from '$lib/graph/stereo-autowire';
  import type { DropChoice } from '$lib/graph/stereo-drop-choice';

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Header — the cable about to be made ("OSC OUT → CLOUDS IN"). */
    title: string;
    /** The decision, straight from `planDropChoice`. */
    choice: DropChoice | null;
    /** Human label for a port id, resolved by the caller through the SAME
     *  resolver the patch panel rows use, so the menu cannot promise a label
     *  the card then renders differently. */
    labelFor: (portId: string) => string;
    onpick: (mode: ChannelMode) => void;
    /** Escape, negative space, or a re-open — the patch is ABANDONED. */
    oncancel: () => void;
  }

  let { open = $bindable(false), x, y, title, choice, labelFor, onpick, oncancel }: Props =
    $props();

  let menuEl: HTMLDivElement | null = $state(null);

  /**
   * The prompt line. It names the SHAPE of the mismatch rather than the ports,
   * because the ports are already on the rows underneath it.
   */
  let prompt = $derived(
    choice?.kind === 'stereo-to-mono' ? 'stereo → mono: which channel?' : 'mono → stereo: which side?',
  );

  /** One row's text. `both` is the only row that names two ports. */
  function rowLabel(mode: ChannelMode): string {
    if (!choice) return '';
    if (mode === 'both') {
      return `both — ${labelFor(choice.pair.left)} + ${labelFor(choice.pair.right)}`;
    }
    const port = mode === 'left' ? choice.pair.left : choice.pair.right;
    return `${mode === 'left' ? 'L' : 'R'} — ${labelFor(port)}`;
  }

  function pick(mode: ChannelMode): void {
    onpick(mode);
  }

  $effect(() => {
    if (!open) return;
    // CAPTURE + stopPropagation, matching UnpatchMenu and StereoExpandMenu:
    // Escape must cancel THIS gesture only, not also close the dock full-view
    // drawer whose bubble-phase keymap would otherwise fire behind it.
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      oncancel();
    }
    function onDown(e: PointerEvent) {
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      oncancel();
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  });

  // Focus the first row so the whole gesture is reachable from the keyboard
  // (Tab between rows, Enter to pick, Escape to cancel) without the pointer
  // ever leaving where the cable was dropped. Queried rather than bound: a
  // `bind:this` inside an `{#each}` settles on the LAST element, which would
  // have quietly focused BOTH — the row that costs the most.
  $effect(() => {
    if (!open || !menuEl) return;
    const first = menuEl.querySelector<HTMLButtonElement>(
      '[data-testid="stereo-drop-choice-option"]',
    );
    first?.focus();
  });
</script>

{#if open && choice}
  <div
    bind:this={menuEl}
    class="menu"
    use:portal
    use:clampMenu={{ x, y }}
    role="menu"
    tabindex="-1"
    aria-label="Choose which stereo channel to patch"
    data-testid="stereo-drop-choice"
    data-kind={choice.kind}
  >
    <div class="head">{title}</div>
    <div class="prompt">{prompt}</div>
    {#if choice.destroys}
      <div class="warn" data-testid="stereo-drop-choice-occupied">
        this jack is already patched
      </div>
    {/if}
    {#each choice.options as opt (opt.mode)}
      <button
        class="row"
        type="button"
        role="menuitem"
        data-testid="stereo-drop-choice-option"
        data-mode={opt.mode}
        data-replaces={opt.replaceEdgeIds.length > 0 ? 'true' : 'false'}
        onclick={() => pick(opt.mode)}
      >
        <span class="what">{rowLabel(opt.mode)}</span>
        {#if opt.replaceEdgeIds.length > 0}
          <span class="cost">replaces</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 10000;
    min-width: 210px;
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

  .prompt {
    padding: 6px 8px 4px;
    color: var(--fg-dim, #999);
    font-size: 10px;
    white-space: nowrap;
  }

  .warn {
    margin: 0 4px 2px;
    padding: 4px 4px;
    border-radius: 4px;
    background: var(--warn-dim, #3a2a12);
    color: var(--warn, #e0a44a);
    font-size: 10px;
    white-space: nowrap;
  }

  .row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    justify-content: space-between;
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

  .cost {
    color: var(--warn, #e0a44a);
    font-size: 10px;
  }
</style>
