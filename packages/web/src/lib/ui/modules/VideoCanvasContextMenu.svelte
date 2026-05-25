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

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Title at the top — usually the module name. */
    title: string;
    onfullscreen: () => void;
    /** Optional in-app "Full Frame" toggle: expand the card's video surface
     *  to consume the card border (hide knobs/jacks/labels), staying in the
     *  rack. Distinct from `onfullscreen` (true browser fullscreen). When
     *  omitted, the Full Frame item is not shown. */
    onfullframe?: () => void;
    /** Whether the card is currently in full-frame, so the item can read
     *  "Full Frame" vs "Exit Full Frame". */
    isFullFrame?: boolean;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    onfullscreen,
    onfullframe,
    isFullFrame = false,
    onclose,
  }: Props = $props();

  // The menu is `position: fixed` and anchored at the cursor. For a card
  // whose canvas sits low/right in the viewport (e.g. BENTBOX, whose screen
  // area is high in a tall card so the click Y is deep down the page), the
  // menu would extend past the viewport edge and its items become
  // unclickable / off-screen. Measure the menu and clamp the anchor so the
  // whole menu always stays on-screen (shift up/left when it would overflow).
  let menuEl: HTMLDivElement | null = $state(null);
  // Seed with the raw cursor anchor so the first paint is already close;
  // the $effect below corrects it to the clamped position post-mount.
  let posX = $state(x);
  let posY = $state(y);

  function clampToViewport() {
    if (!menuEl) {
      posX = x;
      posY = y;
      return;
    }
    const MARGIN = 8;
    const { width, height } = menuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    posX = Math.max(MARGIN, Math.min(x, vw - width - MARGIN));
    posY = Math.max(MARGIN, Math.min(y, vh - height - MARGIN));
  }

  // Recompute whenever the menu opens or the anchor moves. The menu element
  // exists (bind:this resolved) by the time this effect runs after render.
  $effect(() => {
    if (!open) return;
    // Touch x/y so the effect re-runs if the anchor changes while open.
    void x;
    void y;
    clampToViewport();
  });

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    const onResize = () => clampToViewport();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  });

  function pickFullscreen() {
    onfullscreen();
    onclose();
  }

  function pickFullFrame() {
    onfullframe?.();
    onclose();
  }

  // Render the menu + overlay at <body> so they escape SvelteFlow's pane
  // `transform` (zoom/pan). A `position: fixed` element nested inside a
  // transformed ancestor anchors to that ANCESTOR's box, not the viewport —
  // so without this the menu lands wherever the transformed node sits (for
  // the BENTBOX card that pushed it fully off the right edge, making the
  // Fullscreen item unclickable). Portaling to body restores true
  // viewport-fixed positioning so the cursor anchor + clamp are correct.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

{#if open}
  <div use:portal>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
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
      bind:this={menuEl}
      class="ctx-menu"
      style:left="{posX}px"
      style:top="{posY}px"
      role="menu"
      aria-label="Video actions"
      data-testid="video-canvas-context-menu"
    >
      <div class="ctx-header">{title}</div>
      <button
        class="ctx-item"
        onclick={pickFullscreen}
        role="menuitem"
        data-testid="ctx-fullscreen"
      >
        Fullscreen
      </button>
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
</style>
