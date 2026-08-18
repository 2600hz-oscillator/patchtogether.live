<script lang="ts">
  // Minimal right-click menu for a video card's canvas/preview area.
  // Today it carries a single action: Fullscreen (true browser fullscreen
  // via the Fullscreen API). Anchored at the cursor like ControlContextMenu,
  // so it looks + feels the same as the other canvas menus.
  //
  // This is intentionally a CANVAS-local menu: a plain right-click on the
  // video surface claims the menu (the canvas isn't a control surface, so
  // there's nothing to steal). The card handler calls preventDefault +
  // stopPropagation so the SvelteFlow node menu (Docs / Duplicate / Delete)
  // doesn't also fire. Right-click anywhere ELSE on the card still falls
  // through to the node menu.

  import type { AvailableScreen } from './use-fullscreen.svelte';

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Title at the top — usually the module name. */
    title: string;
    /** Fullscreen the video. Receives the chosen display id when the user
     *  picks a specific monitor (Window Management API); undefined means the
     *  current/primary display. */
    onfullscreen: (screenId?: string) => void;
    /** Multi-monitor displays available for targeted fullscreen. When more
     *  than one is present we render a "Fullscreen on …" item per display;
     *  with 0 or 1 we keep the single "Fullscreen" item (unsupported
     *  browsers / single-monitor — byte-identical to before). */
    availableScreens?: AvailableScreen[];
    /** Called when the menu opens so the parent can lazily request the screen
     *  list (the Window Management permission prompt must fire on this user
     *  gesture). Optional; cards that don't support multi-monitor omit it. */
    onrequestscreens?: () => void;
    /** Optional in-app "Full Frame" toggle: expand the card's video surface
     *  to consume the card border (hide knobs/jacks/labels), staying in the
     *  rack. Distinct from `onfullscreen` (true browser fullscreen). When
     *  omitted, the Full Frame item is not shown. */
    onfullframe?: () => void;
    /** Whether the card is currently in full-frame, so the item can read
     *  "Full Frame" vs "Exit Full Frame". */
    isFullFrame?: boolean;
    /** Optional "Present on <display>" handler: open a SEPARATE popup window
     *  on the chosen display fed this card's live canvas, leaving the main
     *  window interactive (unlike fullscreen, which relocates the whole tab).
     *  Only offered for NON-current displays in multi-monitor mode. When
     *  omitted (or single-monitor / unsupported), no present items show. */
    onpresent?: (screenId: string) => void;
    /** Optional "Present on ALL displays" handler: open a popup on every
     *  secondary display in ONE click (the multi-projector case). Shown only
     *  when wired AND there's more than one secondary display. */
    onpresentall?: () => void;
    /** Stop an active present session (close the popup + release the capture).
     *  When provided AND `isPresenting`, a "Stop presenting" item shows. */
    onstoppresent?: () => void;
    /** Whether a present popup is currently open, so we can show "Stop
     *  presenting". */
    isPresenting?: boolean;

    // ── DETACH DISPLAY (#1821) ────────────────────────────────────────────
    //
    // ⚠ ONE MENU, TWO ENTRY POINTS — that is the whole point of putting these
    // here rather than in each surface. The owner asked that re-attach be
    // reachable from "either it OR the underlying video output card"; both
    // surfaces mount THIS component, so the two entries are the same code and
    // cannot drift apart. Prop-gated like every item above: a card that does not
    // wire the handler simply does not show the item.

    /** DETACH — float this module's picture free of its card. Shown only when
     *  wired AND not already detached. */
    ondetach?: () => void;
    /** RE-ATTACH — put the picture back on the card. Shown when wired AND
     *  `isDetached`. */
    onreattach?: () => void;
    /** Whether this module's display is currently detached. Chooses between the
     *  two items above; both may be wired at once. */
    isDetached?: boolean;
    /**
     * DELETE THE MODULE. Wired by the DETACHED PANEL only, and it must route
     * into the node's OWN delete path rather than re-implementing one — the
     * owner's *"if i right click the floating output and delete it the card goes
     * away"*. The reverse direction needs no handler at all: the panel renders
     * only while its node is in the graph, so deleting the card takes it with
     * it by construction.
     */
    ondelete?: () => void;

    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    onfullscreen,
    availableScreens = [],
    onrequestscreens,
    onfullframe,
    isFullFrame = false,
    onpresent,
    onpresentall,
    onstoppresent,
    isPresenting = false,
    ondetach,
    onreattach,
    isDetached = false,
    ondelete,
    onclose,
  }: Props = $props();

  // Show per-display entries only when there's a genuine multi-monitor
  // choice; otherwise the classic single "Fullscreen" item.
  const multiMonitor = $derived(availableScreens.length > 1);

  // "Present on …" targets the OTHER monitor(s) — presenting on THIS display
  // (the one the patcher is on) makes no sense (it would cover the patcher),
  // so we offer only the non-primary displays. Gated additionally on the
  // onpresent handler being wired (cards opt in) + multi-monitor.
  const presentScreens = $derived(
    onpresent && multiMonitor ? availableScreens.filter((s) => !s.isPrimary) : [],
  );

  // The menu is `position: fixed` and anchored at the cursor. For a card
  // whose canvas sits low/right in the viewport (e.g. BENTBOX, whose screen
  // area is high in a tall card so the click Y is deep down the page), the
  // menu would extend past the viewport edge and its items become
  // unclickable / off-screen. The shared clampMenu action measures the real
  // menu box and flips/clamps so the whole menu always stays on-screen
  // (re-clamping on anchor change, content resize, and window resize).

  // Opening the menu is a user gesture — the only moment we may invoke the
  // Window Management API (it can prompt for permission). Ask the parent to
  // populate the screen list now; the menu re-renders reactively if/when more
  // than one display arrives.
  let requestedThisOpen = false;
  $effect(() => {
    if (open && !requestedThisOpen) {
      requestedThisOpen = true;
      onrequestscreens?.();
    } else if (!open) {
      requestedThisOpen = false;
    }
  });

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  function pickFullscreen(screenId?: string) {
    onfullscreen(screenId);
    onclose();
  }

  function pickFullFrame() {
    onfullframe?.();
    onclose();
  }

  function pickPresent(screenId: string) {
    onpresent?.(screenId);
    onclose();
  }

  function pickPresentAll() {
    onpresentall?.();
    onclose();
  }

  function pickStopPresent() {
    onstoppresent?.();
    onclose();
  }

  function pickDetach() {
    ondetach?.();
    onclose();
  }

  function pickReattach() {
    onreattach?.();
    onclose();
  }

  function pickDelete() {
    ondelete?.();
    onclose();
  }

  // Render the menu + overlay at <body> so they escape SvelteFlow's pane
  // `transform` (zoom/pan). A `position: fixed` element nested inside a
  // transformed ancestor anchors to that ANCESTOR's box, not the viewport —
  // so without this the menu lands wherever the transformed node sits (for
  // the BENTBOX card that pushed it fully off the right edge, making the
  // Fullscreen item unclickable). Portaling to body restores true
  // viewport-fixed positioning so the cursor anchor + clamp are correct.
  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
</script>

{#if open}
  <div use:portal>
    <div
      class="ctx-overlay"
      onclick={onclose}
      oncontextmenu={(e) => {
        e.preventDefault();
        onclose();
      }}
      role="presentation"
    ></div>
    <div
      class="ctx-menu"
      use:clampMenu={{ x, y }}
      role="menu"
      aria-label="Video actions"
      data-testid="video-canvas-context-menu"
    >
      <div class="ctx-header">{title}</div>
      {#if multiMonitor}
        {#each availableScreens as screen (screen.id)}
          <button
            class="ctx-item"
            onclick={() => pickFullscreen(screen.id)}
            role="menuitem"
            data-testid="ctx-fullscreen-{screen.id}"
          >
            {screen.isPrimary
              ? 'Fullscreen on THIS DISPLAY'
              : `Fullscreen on ${screen.label}`}
          </button>
        {/each}
      {:else}
        <button
          class="ctx-item"
          onclick={() => pickFullscreen()}
          role="menuitem"
          data-testid="ctx-fullscreen"
        >
          Fullscreen
        </button>
      {/if}
      {#if onfullframe}
        <button
          class="ctx-item"
          onclick={pickFullFrame}
          role="menuitem"
          data-testid="ctx-full-frame"
        >
          {isFullFrame ? 'Exit Full Frame' : 'Full Frame'}
        </button>
      {/if}
      {#if presentScreens.length > 0}
        <div class="ctx-sep" role="separator"></div>
        {#if onpresentall && presentScreens.length > 1}
          <!-- One click lights up every secondary display (multi-projector). -->
          <button
            class="ctx-item"
            onclick={pickPresentAll}
            role="menuitem"
            data-testid="ctx-present-all"
          >
            Present on all displays ({presentScreens.length})
          </button>
        {/if}
        {#each presentScreens as screen (screen.id)}
          <button
            class="ctx-item"
            onclick={() => pickPresent(screen.id)}
            role="menuitem"
            data-testid="ctx-present-{screen.id}"
          >
            Present on {screen.label}
          </button>
        {/each}
      {/if}
      {#if onstoppresent && isPresenting}
        <button
          class="ctx-item"
          onclick={pickStopPresent}
          role="menuitem"
          data-testid="ctx-stop-present"
        >
          Stop presenting
        </button>
      {/if}
      <!-- DETACH DISPLAY (#1821). The pair is EXCLUSIVE by state, not by which
           surface opened the menu, so the card and the floating panel show the
           same item for the same node. -->
      {#if ondetach && !isDetached}
        <div class="ctx-sep" role="separator"></div>
        <button
          class="ctx-item"
          onclick={pickDetach}
          role="menuitem"
          data-testid="ctx-detach-display"
        >
          Detach display
        </button>
      {/if}
      {#if onreattach && isDetached}
        <div class="ctx-sep" role="separator"></div>
        <button
          class="ctx-item"
          onclick={pickReattach}
          role="menuitem"
          data-testid="ctx-reattach-display"
        >
          Re-attach display
        </button>
      {/if}
      {#if ondelete}
        <button
          class="ctx-item danger"
          onclick={pickDelete}
          role="menuitem"
          data-testid="ctx-delete-module"
        >
          Delete module
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
  }
  .ctx-menu {
    position: fixed;
    z-index: 9001;
    min-width: 180px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    font-size: 0.85rem;
    padding: 4px 0;
  }
  .ctx-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 6px 12px 4px;
    pointer-events: none;
  }
  .ctx-item {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px 12px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }
  .ctx-item:hover,
  .ctx-item:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  .ctx-sep {
    height: 1px;
    margin: 4px 0;
    background: #404652;
  }
  /* Destructive: the one item here that removes a module from the rack. */
  .ctx-item.danger {
    color: var(--danger, #f87171);
  }
  .ctx-item.danger:hover,
  .ctx-item.danger:focus-visible {
    background: rgba(248, 113, 113, 0.12);
  }
</style>
