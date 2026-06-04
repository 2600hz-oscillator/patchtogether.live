<script lang="ts">
  // ToyboxNodeMenu — the contextual right-click menu for the TOYBOX in-card
  // combine-graph editor (the SVG node map inside ToyboxCard). It is AWARE of
  // what was right-clicked and offers only the relevant actions:
  //
  //   NODE (op)     Patch to output · Disconnect · Duplicate node · Delete node
  //   NODE (source) Patch to output · Disconnect            (no Delete/Duplicate)
  //   NODE (output) Disconnect                              (structural endpoint)
  //   PORT (output) Patch to output · Disconnect this port · Begin wire
  //   PORT (input)  Disconnect this port
  //   EDGE          Delete edge
  //   CANVAS        Add node ▸ (fade/lumakey/chromakey/map) · Clear · Reset
  //
  // This clones NodeContextMenu / PortContextMenu's overlay + fixed-div + Esc +
  // CSS pattern (the repo has no shared <ContextMenu> primitive yet; cloning
  // matches convention). ToyboxCard owns the classify-target logic + opens this
  // with a small $state object; every action fires a callback then onclose().

  import { OP_KINDS, type ToyboxNodeKind, type ToyboxOpKind, type ToyboxInPort } from '$lib/video/toybox-combine-graph';

  type MenuKind = 'node' | 'port' | 'edge' | 'canvas';

  interface Props {
    open: boolean;
    /** Screen-space anchor (cursor position). */
    x: number;
    y: number;
    /** What was right-clicked. */
    kind: MenuKind;
    /** NODE/PORT only: the structural kind of the node (source/op/output) — gates
     *  which items show. */
    nodeKind?: ToyboxNodeKind;
    /** PORT only: 'out' (right dot) or 'in' (left dot). */
    dir?: 'in' | 'out';
    /** PORT (input) only: which input port. */
    port?: ToyboxInPort;
    // ---- action callbacks (ToyboxCard wires these to the mutators) ----
    onpatchtooutput: () => void;
    ondisconnect: () => void;
    onduplicate: () => void;
    ondeletenode: () => void;
    ondisconnectport: () => void;
    onbeginwire: () => void;
    ondeleteedge: () => void;
    onaddnode: (kind: ToyboxOpKind) => void;
    onclear: () => void;
    onreset: () => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    kind,
    nodeKind,
    dir,
    port,
    onpatchtooutput,
    ondisconnect,
    onduplicate,
    ondeletenode,
    ondisconnectport,
    onbeginwire,
    ondeleteedge,
    onaddnode,
    onclear,
    onreset,
    onclose,
  }: Props = $props();

  // The "Add node ▸" cascade is expanded only after the user hovers/clicks it.
  // Resets every time the menu reopens.
  let addOpen = $state(false);
  $effect(() => {
    if (!open) addOpen = false;
  });

  // Viewport-clamped position. The raw cursor (x, y) is the desired anchor, but
  // a `position: fixed` menu opened near the bottom/right edge would overflow the
  // viewport and render UNDER the canvas bottombar footer (which then intercepts
  // pointer events on the lower items — e.g. "Reset to default" becomes
  // unclickable). After the menu mounts we measure it and flip/clamp so it always
  // stays fully on-screen. Falls back to (x, y) until measured.
  let menuEl = $state<HTMLDivElement | null>(null);
  let posX = $state(0);
  let posY = $state(0);
  $effect(() => {
    if (!open) return;
    // Seed at the cursor, then clamp once the DOM (incl. an expanded cascade) is
    // laid out. Re-runs when x/y/addOpen change so the submenu growth is covered.
    void x; void y; void addOpen;
    posX = x;
    posY = y;
    const el = menuEl;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const margin = 6;
      const maxX = window.innerWidth - rect.width - margin;
      const maxY = window.innerHeight - rect.height - margin;
      posX = Math.max(margin, Math.min(x, maxX));
      posY = Math.max(margin, Math.min(y, maxY));
    };
    clamp();
    // A second pass after layout settles (fonts/cascade) keeps it pinned.
    const raf = requestAnimationFrame(clamp);
    return () => cancelAnimationFrame(raf);
  });

  // Window-level Escape handler (context menus don't take focus — Esc must
  // dismiss regardless of where focus sits). Mirrors NodeContextMenu.
  $effect(() => {
    if (!open) return;
    const onWindowKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onWindowKeydown);
    return () => window.removeEventListener('keydown', onWindowKeydown);
  });

  // Structural gating helpers.
  let isSource = $derived(nodeKind === 'source');
  let isOutput = $derived(nodeKind === 'output');
  let isOp = $derived(nodeKind !== 'source' && nodeKind !== 'output');

  // The menu header label per target.
  let headerLabel = $derived.by<string>(() => {
    if (kind === 'edge') return 'Edge';
    if (kind === 'canvas') return 'Node map';
    if (kind === 'port') return dir === 'out' ? 'Output port' : `Input ${port ?? ''}`.trim();
    // node
    if (isSource) return 'Source';
    if (isOutput) return 'Output';
    return (nodeKind ?? 'node').toUpperCase();
  });

  function pick(fn: () => void) {
    fn();
    onclose();
  }

  // Portal the menu to <body>. This component is rendered INSIDE ToyboxCard,
  // which lives inside a svelte-flow node whose ancestor carries a CSS transform
  // — and a transformed ancestor becomes the containing block for `position:
  // fixed`, so our menu's left/top (set from the cursor's viewport clientX/
  // clientY) would resolve against the node, not the viewport (it then lands in
  // the wrong place + can render under the canvas bottombar footer, which
  // intercepts clicks on the lower items). Re-parenting to <body> escapes the
  // transform so fixed-positioning matches the cursor. Mirrors
  // ControlContextMenu / VideoCanvasContextMenu.
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
    bind:this={menuEl}
    class="ctx-menu"
    style:left="{posX}px"
    style:top="{posY}px"
    role="menu"
    aria-label="Node map actions"
    data-testid="toybox-node-menu"
  >
    <div class="ctx-header">{headerLabel}</div>

    {#if kind === 'node'}
      {#if !isOutput}
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-patch-output"
          onclick={() => pick(onpatchtooutput)}
        >Patch to output</button>
      {/if}
      <button
        class="ctx-item"
        role="menuitem"
        data-testid="toybox-menu-disconnect"
        onclick={() => pick(ondisconnect)}
      >Disconnect</button>
      {#if isOp}
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-duplicate"
          onclick={() => pick(onduplicate)}
        >Duplicate node</button>
        <button
          class="ctx-item danger"
          role="menuitem"
          data-testid="toybox-menu-delete-node"
          onclick={() => pick(ondeletenode)}
        >Delete node</button>
      {/if}

    {:else if kind === 'port'}
      {#if dir === 'out'}
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-patch-output"
          onclick={() => pick(onpatchtooutput)}
        >Patch to output</button>
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-disconnect-port"
          onclick={() => pick(ondisconnectport)}
        >Disconnect this port</button>
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-begin-wire"
          onclick={() => pick(onbeginwire)}
        >Begin wire</button>
      {:else}
        <button
          class="ctx-item"
          role="menuitem"
          data-testid="toybox-menu-disconnect-port"
          onclick={() => pick(ondisconnectport)}
        >Disconnect this port</button>
      {/if}

    {:else if kind === 'edge'}
      <button
        class="ctx-item danger"
        role="menuitem"
        data-testid="toybox-menu-delete-edge"
        onclick={() => pick(ondeleteedge)}
      >Delete edge</button>

    {:else if kind === 'canvas'}
      <div class="cascade-row">
        <div class="cascade-col">
          <button
            class="ctx-item cascade-trigger"
            class:active={addOpen}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            data-testid="toybox-menu-add"
            onmouseenter={() => (addOpen = true)}
            onfocus={() => (addOpen = true)}
            onclick={() => (addOpen = true)}
          >Add node <span class="chev" aria-hidden="true">▸</span></button>
          {#if addOpen}
            <ul class="submenu" role="menu" aria-label="Add op node" data-testid="toybox-menu-add-kinds">
              {#each OP_KINDS as k (k)}
                <li>
                  <button
                    type="button"
                    class="ctx-item"
                    role="menuitem"
                    data-testid={`toybox-menu-add-${k}`}
                    onclick={() => pick(() => onaddnode(k))}
                  >{k}</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
      <div class="ctx-sep" role="presentation"></div>
      <button
        class="ctx-item"
        role="menuitem"
        data-testid="toybox-menu-clear"
        onclick={() => pick(onclear)}
      >Clear node map</button>
      <button
        class="ctx-item"
        role="menuitem"
        data-testid="toybox-menu-reset"
        onclick={() => pick(onreset)}
      >Reset to default</button>
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
  .ctx-menu {
    position: fixed;
    z-index: 201;
    min-width: 160px;
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
  .ctx-item:focus-visible,
  .ctx-item.active {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  .ctx-item.danger {
    color: #f87171;
  }
  .ctx-item.danger:hover,
  .ctx-item.danger:focus-visible {
    background: rgba(248, 113, 113, 0.12);
  }
  .ctx-sep {
    height: 1px;
    background: #404652;
    margin: 4px 0;
  }
  /* Add-node cascade (canvas target). */
  .cascade-row {
    display: flex;
    align-items: stretch;
  }
  .cascade-col {
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }
  .cascade-trigger {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .chev {
    color: var(--text-dim);
  }
  .submenu {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border-top: 1px solid #2a2f3a;
  }
  .submenu .ctx-item {
    text-transform: uppercase;
    font-size: 0.78rem;
    padding-left: 20px;
  }
</style>
