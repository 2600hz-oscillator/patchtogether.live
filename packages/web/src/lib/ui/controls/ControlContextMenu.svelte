<script lang="ts">
  // Right-click context menu for a single knob / slider.
  //
  //   MIDI Learn          — capture next CC and bind it to this control
  //   Forget MIDI binding — drop the saved binding (if any)
  //
  // Layout mirrors NodeContextMenu.svelte exactly so the menus look + feel
  // alike across the canvas. Anchored at the cursor position (x, y).

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Optional title at the top — usually "Module — Param". */
    title: string;
    /** Is there a learned binding to surface a "Forget" option for? */
    hasBinding: boolean;
    /** Optional human description of the current binding (e.g. "CH 1 · CC 7"). */
    bindingLabel?: string;
    onlearn: () => void;
    onforget: () => void;
    onclose: () => void;
    /** Control surfaces this control can be sent to. `bound` = the control is
     *  already on that surface (we offer "Remove from" instead of "Send to").
     *  Omitted/empty → the surface section is hidden (no surfaces in patch). */
    surfaces?: Array<{ id: string; name: string; bound: boolean }>;
    /** Add this control as a pointer on the given surface. */
    onsendtosurface?: (surfaceId: string) => void;
    /** Remove this control's pointer from the given surface. */
    onremovefromsurface?: (surfaceId: string) => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    hasBinding,
    bindingLabel,
    onlearn,
    onforget,
    onclose,
    surfaces = [],
    onsendtosurface,
    onremovefromsurface,
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

  function pickLearn() { onlearn(); onclose(); }
  function pickForget() { onforget(); onclose(); }
  function pickSurface(s: { id: string; bound: boolean }) {
    if (s.bound) onremovefromsurface?.(s.id);
    else onsendtosurface?.(s.id);
    onclose();
  }

  // Portal the menu to <body>. The control menu is rendered inside a
  // SvelteFlow node, which lives under `.svelte-flow__viewport` — an element
  // with a CSS `transform` (pan/zoom). A transformed ancestor becomes the
  // containing block for `position: fixed` descendants, so without this the
  // menu's `left/top` (cursor clientX/clientY) would be interpreted in the
  // transformed/scaled canvas space and land in the wrong spot (drifting as
  // you pan/zoom). Appending to <body> removes the transformed ancestor so
  // fixed-positioning resolves against the real viewport → menu spawns under
  // the cursor. Mirrors VideoCanvasContextMenu.svelte.
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
      oncontextmenu={(e) => { e.preventDefault(); onclose(); }}
      role="presentation"
    ></div>
    <div
      class="ctx-menu"
      style:left="{x}px"
      style:top="{y}px"
      role="menu"
      aria-label="Control actions"
      data-testid="control-context-menu"
    >
      <div class="ctx-header">{title}</div>
      <button
        class="ctx-item"
        onclick={pickLearn}
        role="menuitem"
        data-testid="ctx-midi-learn"
      >
        MIDI Learn…
      </button>
      {#if hasBinding}
        <button
          class="ctx-item subtle"
          onclick={pickForget}
          role="menuitem"
          data-testid="ctx-midi-forget"
        >
          Forget {bindingLabel ?? 'binding'}
        </button>
      {/if}
      {#if surfaces.length > 0}
        <div class="ctx-divider" role="separator"></div>
        {#each surfaces as s (s.id)}
          <button
            class="ctx-item"
            class:subtle={s.bound}
            onclick={() => pickSurface(s)}
            role="menuitem"
            data-testid={`ctx-surface-${s.id}`}
            data-bound={s.bound ? 'true' : 'false'}
          >
            {s.bound ? `Remove from ${s.name}` : `Send to ${s.name}`}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
  }
  .ctx-divider {
    height: 1px;
    margin: 4px 0;
    background: #353b46;
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
  .ctx-item.subtle {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .ctx-item:hover,
  .ctx-item:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
</style>
