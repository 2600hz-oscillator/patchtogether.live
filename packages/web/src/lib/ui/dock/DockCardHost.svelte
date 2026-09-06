<script lang="ts">
  // DockCardHost — mounts ONE module faceplate in a dock rail, OUTSIDE the
  // SvelteFlow provider (P2.5a). This is the spike-proven plain-mount host:
  //
  //  * The occupant is the SAME `<ModuleShell>` the canvas mounts in a lane,
  //    fed the same `{ id, data: { node } }` shape. No second implementation.
  //  * PatchPanel self-gates outside the provider (guarded useStore): no
  //    <Handle> stack mounts here, so the node's ONLY handles + only
  //    `.svelte-flow__node[data-id]` element live on its canvas
  //    DockStubCard — PickupCable + sweep selector contracts stay
  //    unambiguous. The patch MENU still works from the rail (port rows
  //    dispatch document-level events Canvas owns).
  //  * INDEPENDENT ZOOM: discrete 50–150% in 25% steps. The inner wrapper
  //    is transform-scaled from its top-left; the frame's layout box is
  //    the MEASURED natural size × scale (ResizeObserver, no per-frame
  //    work), so rail flow stays plain CSS px. Controls: header − / % / +
  //    (⟲ reset on the % readout) and Cmd/Ctrl+wheel over the card WITH a
  //    target guard — Knob/Fader treat ctrl/meta-wheel as fine-adjust and
  //    do NOT stop propagation, so wheel events over a control are theirs,
  //    never a zoom.
  //
  //  * ⚠ THE MOUNT IS UNCONDITIONAL, and it did not used to be. This host took
  //    a `face` boolean and an injected component map, and fell through to
  //    `nodeTypes[node.type]` when the flag was false. That map holds exactly
  //    two entries — `dockStub` and `moduleShell` — and a node's `type` is
  //    neither, so the fall-through could only ever have reached the
  //    "unknown module type" plate. Both callers passed the flag TRUE
  //    unconditionally (DockRail, and AudioIoSurface for its two singletons),
  //    so the branch was unreachable in both directions: dead if the flag was
  //    true, broken if it ever went false. It is one mount now.
  //
  //    `view='drawer'` is the shell view that renders the full faceplate AND
  //    keeps the lane `PatchPanel`, because this host has no title bar and
  //    therefore no flip-to-rear: that PatchPanel is the tray's only patch
  //    surface, front and rear. Everything else is untouched — the same
  //    `<section data-dock-card>` and `[data-dock-card-frame]` anchors
  //    (cardRectFor / PickupCable / PatchPanel.cardRectOf all resolve through
  //    them), the same header, the same zoom ladder, the same ✕.

  import type { ModuleNode } from '$lib/graph/types';
  import ModuleShell from '$lib/ui/modules/ModuleShell.svelte';
  import { ZOOM_MAX, ZOOM_MIN } from './dock-entries';

  interface Props {
    /** The docked node (live snapshot entry — `data` is the live proxy). */
    node: ModuleNode;
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
    scale,
    title,
    onStepScale,
    onResetScale,
    onUndock,
    onClose,
  }: Props = $props();

  // ⚠ NO RACK SIZING HERE, and that is not an omission. The rack tier was a
  // per-TYPE height mirrored onto a wrapper class, and the rules it fed select
  // roots a `.module-shell` deliberately is not — so the tier reached this host
  // as `--rack-u/--rack-hp` that nothing read. The face sizes itself, which is
  // why the ResizeObserver below can measure it.

  // Natural (unscaled) content size, measured once + on content-driven changes.
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
      <div bind:this={innerEl} class="dock-natural-sized">
        <ModuleShell id={node.id} data={{ node, view: 'drawer' }} />
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
  /* The inner box positions the faceplate the way a .svelte-flow__node wrapper
     does: absolutely-positioned children (patch triggers etc.) resolve against
     a root that is position:static inside a plain div — same as inside
     xyflow's wrapper. */
  .dock-natural-sized {
    position: relative;
    width: max-content;
  }
</style>
