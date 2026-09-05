<script lang="ts">
  // DockCardHost — mounts ONE module card in a dock rail, OUTSIDE the
  // SvelteFlow provider (P2.5a). This is the spike-proven plain-mount host:
  //
  //  * The card is the SAME component the canvas mounts (resolved via the
  //    shared nodeTypes map), fed the same `{ id, data: { node } }` shape.
  //    No second implementation.
  //  * PatchPanel self-gates outside the provider (guarded useStore): no
  //    <Handle> stack mounts here, so the node's ONLY handles + only
  //    `.svelte-flow__node[data-id]` element live on its canvas
  //    DockStubCard — PickupCable + sweep selector contracts stay
  //    unambiguous. The patch MENU still works from the rail (port rows
  //    dispatch document-level events Canvas owns).
  //  * Rack sizing is replicated by a classed wrapper (`dock-rack-sized`
  //    in _module-card.css) that mirrors `.svelte-flow__node.rack-sized`
  //    WITHOUT the .svelte-flow__node class (selector collisions).
  //  * INDEPENDENT ZOOM: discrete 50–150% in 25% steps. The inner wrapper
  //    is transform-scaled from its top-left; the frame's layout box is
  //    the MEASURED natural size × scale (ResizeObserver, no per-frame
  //    work), so rail flow stays plain CSS px. Controls: header − / % / +
  //    (⟲ reset on the % readout) and Cmd/Ctrl+wheel over the card WITH a
  //    target guard — Knob/Fader treat ctrl/meta-wheel as fine-adjust and
  //    do NOT stop propagation, so wheel events over a control are theirs,
  //    never a zoom.
  //
  //  * THE PROMOTED FACE (#1739). When the occupant renders its FACEPLATE
  //    (`face` — `dockRailRendersFace`, decided in Canvas so `?shell=legacy`
  //    and `migrated()` are read in ONE place), the mounted component is
  //    `<ModuleShell view='drawer'>` instead of `nodeTypes[type]`. Everything
  //    else on this host is untouched: the same `<section data-dock-card>` and
  //    `[data-dock-card-frame]` anchors (cardRectFor / PickupCable /
  //    PatchPanel.cardRectOf all resolve through them), the same header, the
  //    same zoom ladder, the same ✕. `view='drawer'` is the shell view that
  //    renders the full faceplate AND keeps the lane `PatchPanel`, because this
  //    host has no title bar and therefore no flip-to-RearCard: that PatchPanel
  //    is the tray's only patch surface, front and rear.

  import type { Component } from 'svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleShell from '$lib/ui/modules/ModuleShell.svelte';
  import { ZOOM_MAX, ZOOM_MIN } from './dock-entries';

  interface Props {
    /** The docked node (live snapshot entry — `data` is the live proxy). */
    node: ModuleNode;
    /** The shared glob-driven nodeTypes map (Canvas's). */
    nodeTypes: Record<string, unknown>;
    /** Mount the PROMOTED FACEPLATE (`<ModuleShell view='drawer'>`) rather than
     *  the verbatim legacy card. Injected — `dockRailRendersFace` in
     *  legacy-fallback.ts owns the rule and Canvas evaluates it, so this host
     *  stays registry-free and does not re-derive `?shell=legacy` /
     *  `migrated()`. */
    face?: boolean;
    /** Rack sizing (Canvas's rackSizeByType entry), if the type declares one. */
    rackSize?: { size?: string; hp?: number };
    /** Discrete content scale (dockStore.scaleOf; 0.5–1.5). */
    scale: number;
    /** Header label (display name). */
    title: string;
    /** Step the scale (dockStore.stepScaleOf). */
    onStepScale: (direction: 1 | -1) => void;
    /** Reset scale to 100%. */
    onResetScale: () => void;
    /** Undock → return to canvas (docked entries; hidden for pinned). */
    onUndock?: () => void;
    /** Close the drawer (pinned occupants only). */
    onClose?: () => void;
  }
  let {
    node,
    nodeTypes,
    face = false,
    rackSize,
    scale,
    title,
    onStepScale,
    onResetScale,
    onUndock,
    onClose,
  }: Props = $props();

  let CardComponent = $derived(nodeTypes[node.type] as Component | undefined);

  // RACK SIZING is a LEGACY-CARD mirror and does not apply to a face. The rules
  // it feeds (`_module-card.css`: `.dock-rack-sized > :is(.mod-card, .card,
  // .moog-panel)`) select the three legacy card roots, which a `.module-shell`
  // is deliberately not — so a face in a `.dock-rack-sized` wrapper would carry
  // `--rack-u/--rack-hp` that nothing reads. The face sizes itself.
  let rackU = $derived(face ? null : rackSize?.size ? parseInt(rackSize.size, 10) || 1 : null);
  let rackHp = $derived(rackSize?.hp ?? 1);

  // Natural (unscaled) card size, measured once + on card-driven changes.
  // The frame's layout box is natural × scale so neighbours reflow only on
  // an actual scale/size change — never per frame.
  let natW = $state(0);
  let natH = $state(0);
  let innerEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    const el = innerEl;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      natW = el.offsetWidth;
      natH = el.offsetHeight;
    });
    ro.observe(el);
    natW = el.offsetWidth;
    natH = el.offsetHeight;
    return () => ro.disconnect();
  });

  /** Cmd/Ctrl+wheel = dock zoom — EXCEPT over a Knob/Fader/slider, whose
   *  own wheel handler treats ctrl/meta as fine-adjust (and doesn't stop
   *  propagation). The guard leaves those events entirely to the control. */
  function onFrameWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    const t = e.target as Element | null;
    if (t?.closest('.knob-wrap, .fader-wrap, [role="slider"]')) return;
    e.preventDefault();
    onStepScale(e.deltaY < 0 ? 1 : -1);
  }
</script>

<section
  class="dock-card"
  data-dock-card={node.id}
  data-dock-type={node.type}
  data-dock-scale={scale}
  aria-label={`${title} (docked)`}
>
  <header class="dock-card-header">
    <span class="dock-card-title" title={title}>{title}</span>
    <span class="dock-card-zoom" role="group" aria-label="Card zoom">
      <button
        class="dock-btn"
        data-testid="dock-zoom-out"
        onclick={() => onStepScale(-1)}
        disabled={scale <= ZOOM_MIN}
        title="Zoom out (Cmd/Ctrl+wheel)"
        aria-label="Zoom out"
      >−</button>
      <button
        class="dock-btn dock-zoom-pct"
        data-testid="dock-zoom-reset"
        onclick={onResetScale}
        title="Reset zoom to 100%"
        aria-label="Reset zoom"
      >{Math.round(scale * 100)}%</button>
      <button
        class="dock-btn"
        data-testid="dock-zoom-in"
        onclick={() => onStepScale(1)}
        disabled={scale >= ZOOM_MAX}
        title="Zoom in (Cmd/Ctrl+wheel)"
        aria-label="Zoom in"
      >+</button>
    </span>
    {#if onUndock}
      <button
        class="dock-btn dock-undock"
        data-testid="dock-undock"
        onclick={onUndock}
        title="Undock — return the module to the canvas"
        aria-label="Undock"
      >⇲ undock</button>
    {/if}
    {#if onClose}
      <button
        class="dock-btn"
        data-testid="dock-close"
        onclick={onClose}
        title="Close drawer (Esc)"
        aria-label="Close drawer"
      >✕</button>
    {/if}
  </header>
  <!-- The FRAME is the layout box (natural size × scale) and the anchor
       PatchPanel's chrome edge-aligns to in a rail (data-dock-card-frame —
       see cardRectOf). -->
  <div
    class="dock-card-frame"
    data-dock-card-frame
    onwheel={onFrameWheel}
    style:width={natW > 0 ? `${natW * scale}px` : undefined}
    style:height={natH > 0 ? `${natH * scale}px` : undefined}
  >
    <div class="dock-scale-wrap" style:transform={`scale(${scale})`}>
      <!-- THE FACE'S BOX, and why it needs no explicit one (#1739).
           `.module-shell.rl-tile` is `width:100%; height:100%` and the 192×180
           lane pin is scoped to a `.svelte-flow__node` ancestor, so the fear was
           that the ResizeObserver above would measure a collapsed box here. It
           does not, and the reason is the same CSS the dock full view already
           relies on: `.dock-natural-sized` is `width: max-content`, and a
           percentage width resolves as `auto` for its parent's intrinsic sizing,
           so the wrapper takes the face's own max-content width and the face
           then fills it — exactly what `.faceplate-body { min-width: 0;
           width: max-content }` does for mixmstrs in `_dock-faceplate.css`.
           MEASURED at 1440×900: the frame stamps 805 × 1450 and the shell
           renders 805.1 × 1450.3, against the SAME face at 805.1 × 1427.3 in a
           full-view pane — identical width, +23 px for the jack rail the full
           view drops. So the two hosts agree by construction rather than by a
           re-typed width, and there is no number here to go stale. -->
      <div
        bind:this={innerEl}
        class={rackU != null ? 'dock-rack-sized' : 'dock-natural-sized'}
        style={rackU != null ? `--rack-hp:${rackHp};--rack-u:${rackU}` : undefined}
      >
        {#if face}
          <ModuleShell id={node.id} data={{ node, view: 'drawer' }} />
        {:else if CardComponent}
          <CardComponent id={node.id} data={{ node }} />
        {:else}
          <div class="dock-missing">unknown module type: {node.type}</div>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .dock-card {
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    max-width: 100%;
  }
  .dock-card-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-bottom: 1px solid #2a2f3a;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
  }
  .dock-card-title {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text);
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dock-card-zoom {
    display: inline-flex;
    gap: 2px;
  }
  .dock-btn {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.65rem;
    white-space: nowrap;
  }
  .dock-btn:hover:not(:disabled) {
    background: #2a2f3a;
    color: var(--text);
  }
  .dock-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .dock-zoom-pct {
    min-width: 40px;
    font-variant-numeric: tabular-nums;
  }
  .dock-undock {
    color: var(--accent, #00f0ff);
    border-color: var(--accent-dim, #1d5f66);
  }
  .dock-card-frame {
    position: relative;
    overflow: hidden;
    /* The frame's size is stamped inline (natural × scale). Before the
       first measurement it falls back to content flow for one frame. */
  }
  .dock-scale-wrap {
    transform-origin: top left;
    width: max-content;
  }
  /* The natural/rack-sized inner box positions the card the way a
     .svelte-flow__node wrapper does: cards use position:absolute children
     (patch triggers etc.) against the card root, which is position:static
     inside a plain div — same as inside xyflow's wrapper. */
  .dock-natural-sized,
  :global(.dock-rack-sized) {
    position: relative;
    width: max-content;
  }
  .dock-missing {
    padding: 12px;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
</style>
