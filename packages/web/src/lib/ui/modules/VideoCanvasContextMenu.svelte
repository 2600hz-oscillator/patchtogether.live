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
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    onfullscreen,
    onclose,
  }: Props = $props();

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function pickFullscreen() {
    onfullscreen();
    onclose();
  }
</script>

{#if open}
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
    class="ctx-menu"
    style:left="{x}px"
    style:top="{y}px"
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
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
  }
  .ctx-menu {
    position: fixed;
    z-index: 201;
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
