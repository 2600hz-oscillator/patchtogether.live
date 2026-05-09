<script lang="ts">
  // Hover-revealed patch panel — every module card hosts one.
  //
  // Default state: a single small "patch" affordance at the top-left of the
  // card. Every <Handle> declared on the module def is rendered here in the
  // DOM (so the I/O-spec consistency e2e test still finds them) but stacked
  // at (8, 8) with opacity:0 + pointer-events:none. All cables therefore
  // visually anchor to the affordance corner.
  //
  // Hover (or tap) the affordance: a popover patch-panel slides out, with
  // each port rendered as a labeled row carrying the real <Handle>. Handles
  // re-position to their row coordinates on open; we call
  // useUpdateNodeInternals() with `force: true` so Svelte Flow re-measures
  // handleBounds and edges re-route.
  //
  // Approach (a) from .myrobots/plans/ui-patch-panel-refactor.md.
  import { onMount } from 'svelte';
  import { Handle, Position, useUpdateNodeInternals } from '@xyflow/svelte';
  import {
    resolveVerboseLabel,
    groupPortsByCableType,
    type GroupedPorts,
    type PortDescriptor,
  } from '$lib/ui/patch-panel-labels';
  import type { Snippet } from 'svelte';

  /**
   * Props.
   *
   * - `nodeId`: the Svelte Flow node id (passed from the card's `let { id }
   *   = $props()`). Used by useUpdateNodeInternals to ask Svelte Flow to
   *   recompute handleBounds for THIS card after the panel toggles.
   * - `inputs` / `outputs`: ordered port lists. Each entry can override the
   *   verbose label (otherwise it derives from the port id via
   *   resolveVerboseLabel) and can attach a non-default cable color (which
   *   shows up as a stripe on the panel row).
   * - `groupingStrategy`: 'auto' (default) groups inputs by cable type
   *   (Gates → Pitches → CV → Audio → ...) and outputs the same way.
   *   'sectioned' lets the card supply explicit section headers — useful
   *   for mega-modules like RIOTGIRLS where voices need their own grouping.
   * - `sections`: when groupingStrategy === 'sectioned', an array of
   *   { label, inputs, outputs } that PatchPanel renders top-to-bottom.
   * - `panelWidth`: CSS width of the popover (default 280, RIOTGIRLS uses
   *   bigger).
   * - `children`: the slot for the card's main content (knobs, buttons,
   *   widgets — everything that is NOT a Handle).
   */
  interface SectionedGroup {
    label: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
  }

  interface Props {
    nodeId: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
    groupingStrategy?: 'auto' | 'sectioned';
    sections?: SectionedGroup[];
    panelWidth?: number;
    children?: Snippet;
  }

  let {
    nodeId,
    inputs = [],
    outputs = [],
    groupingStrategy = 'auto',
    sections = [],
    panelWidth = 280,
    children,
  }: Props = $props();

  // ---------------- Hover-intent state machine ----------------
  //
  // Three drivers can keep the panel open:
  //   * `hovered`        — mouse is over the trigger or panel
  //   * `pinned`         — user clicked the trigger to lock it open (until
  //                        another click or an outside tap)
  //   * `stayOpenForDrag` — user is mid-connect-drag with a handle inside
  //                        this panel (released on pointerup)
  //
  // Any one of those keeps the panel open; the panel closes only when all
  // three drop. The 200ms hover-close delay only applies to the `hovered`
  // driver, so a click stays sticky and a drag never blinks shut.

  let hovered = $state(false);
  let pinned = $state(false);
  let stayOpenForDrag = $state(false);

  let open = $derived(hovered || pinned || stayOpenForDrag);

  const CLOSE_DELAY_MS = 200;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function openNow() {
    clearCloseTimer();
    hovered = true;
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      hovered = false;
      closeTimer = null;
    }, CLOSE_DELAY_MS);
  }

  function toggle() {
    // Click toggles the pinned driver. We also set hovered=true so the
    // very next mouseleave doesn't immediately schedule-close.
    if (pinned) {
      pinned = false;
      // If the cursor's still on the trigger/panel, hover-driver keeps it
      // open until the user moves away.
    } else {
      pinned = true;
      clearCloseTimer();
    }
  }

  // Close on outside-click for touch / mobile users. We treat ANY
  // patch-panel host (not just this one) as "inside" — clicking a port
  // handle in a sibling panel must not close THIS panel, which is the
  // common multi-card patching case.
  onMount(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!open) return;
      if (stayOpenForDrag) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-patch-panel-node]')) return;
      pinned = false;
      hovered = false;
      clearCloseTimer();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  });

  // ---------------- Drag-while-open guard ----------------
  //
  // The Handle component fires a low-level pointerdown that becomes a
  // connect-drag. We watch for pointerdowns on any handle inside our panel
  // and set stayOpenForDrag — Canvas's onconnectstart/end on the SvelteFlow
  // root would also work but plumbing a callback is more invasive. The
  // global pointerup clears the flag.
  function onPanelPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.svelte-flow__handle')) {
      stayOpenForDrag = true;
      // Watch for the drop / cancel via a one-shot pointerup on the document.
      const release = () => {
        stayOpenForDrag = false;
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
      };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }
  }

  // ---------------- Handle bounds re-measure ----------------
  //
  // Svelte Flow caches handleBounds keyed by node-element resize. Because
  // our open/close doesn't change the card's bounding box (the panel is
  // absolute and overflows), we MUST manually trigger a re-measure so
  // edges re-route.
  const updateNodeInternals = useUpdateNodeInternals();

  $effect(() => {
    // Read `open` so this effect re-runs on every flip.
    void open;
    // RAF-defer to let CSS transitions land their endpoint values before
    // we measure — Svelte Flow uses getBoundingClientRect, which sees
    // mid-transition values. Two RAFs gives the panel enough time to
    // reach its final geometry without making the cable-route feel laggy.
    let f1 = 0;
    let f2 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        updateNodeInternals(nodeId);
      });
    });
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
    };
  });

  // ---------------- Group/sort port lists ----------------

  let inputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(inputs, 'input') : [],
  );
  let outputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(outputs, 'output') : [],
  );

  function cableColorVar(cable: string | undefined): string {
    if (!cable) return 'var(--cable-audio)';
    return `var(--cable-${cable})`;
  }
</script>

<div
  class="patch-panel-host"
  data-patch-panel-node={nodeId}
>
  <button
    class="patch-trigger"
    type="button"
    data-testid="patch-trigger"
    aria-label="Open patch panel"
    aria-expanded={open}
    onmouseenter={openNow}
    onmouseleave={scheduleClose}
    onfocus={openNow}
    onblur={scheduleClose}
    onclick={toggle}
  >
    <!-- Plug glyph — two short verticals + a horizontal stem. CSS-only. -->
    <span class="trigger-glyph" aria-hidden="true">
      <span class="prong"></span>
      <span class="prong"></span>
      <span class="stem"></span>
    </span>
  </button>

  <div
    class="patch-panel"
    class:open
    style:width="{panelWidth}px"
    data-testid="patch-panel"
    aria-hidden={!open}
    onmouseenter={openNow}
    onmouseleave={scheduleClose}
    onpointerdown={onPanelPointerDown}
    role="group"
  >
    {#if groupingStrategy === 'sectioned'}
      {#each sections as section, sIdx (section.label + '-' + sIdx)}
        <section class="panel-section">
          <h3 class="section-title">{section.label}</h3>
          {#if section.inputs && section.inputs.length > 0}
            <h4 class="subgroup-title">Inputs</h4>
            <ul class="row-list">
              {#each section.inputs as port (port.id)}
                <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                  <span class="row-stripe" aria-hidden="true"></span>
                  <span class="row-label" data-testid="port-row-label">
                    {resolveVerboseLabel(port)}
                  </span>
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={port.id}
                    style={`--handle-color: ${cableColorVar(port.cable)};`}
                  />
                </li>
              {/each}
            </ul>
          {/if}
          {#if section.outputs && section.outputs.length > 0}
            <h4 class="subgroup-title">Outputs</h4>
            <ul class="row-list">
              {#each section.outputs as port (port.id)}
                <li class="panel-row right" style:--row-cable={cableColorVar(port.cable)}>
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={port.id}
                    style={`--handle-color: ${cableColorVar(port.cable)};`}
                  />
                  <span class="row-label right" data-testid="port-row-label">
                    {resolveVerboseLabel(port)}
                  </span>
                  <span class="row-stripe right" aria-hidden="true"></span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {:else}
      <!-- 'auto' grouping -->
      {#if inputGroups.length > 0}
        <section class="panel-section">
          <h3 class="section-title">Inputs</h3>
          {#each inputGroups as group (group.cable)}
            <h4 class="subgroup-title">{group.label}</h4>
            <ul class="row-list">
              {#each group.ports as port (port.id)}
                <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                  <span class="row-stripe" aria-hidden="true"></span>
                  <span class="row-label" data-testid="port-row-label">
                    {resolveVerboseLabel(port)}
                  </span>
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={port.id}
                    style={`--handle-color: ${cableColorVar(port.cable)};`}
                  />
                </li>
              {/each}
            </ul>
          {/each}
        </section>
      {/if}
      {#if outputGroups.length > 0}
        <section class="panel-section">
          <h3 class="section-title">Outputs</h3>
          {#each outputGroups as group (group.cable)}
            <h4 class="subgroup-title">{group.label}</h4>
            <ul class="row-list">
              {#each group.ports as port (port.id)}
                <li class="panel-row right" style:--row-cable={cableColorVar(port.cable)}>
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={port.id}
                    style={`--handle-color: ${cableColorVar(port.cable)};`}
                  />
                  <span class="row-label right" data-testid="port-row-label">
                    {resolveVerboseLabel(port)}
                  </span>
                  <span class="row-stripe right" aria-hidden="true"></span>
                </li>
              {/each}
            </ul>
          {/each}
        </section>
      {/if}
    {/if}
  </div>

  {@render children?.()}
</div>

<style>
  .patch-panel-host {
    /* Wraps the affordance + popover + the card's main content slot. The
     * host is `display: contents` so it doesn't add an extra box around
     * the card body — the card's existing layout (faders, knobs) sits
     * directly inside .mod-card without disturbance. */
    display: contents;
  }

  /* ---------------- Trigger affordance (top-left corner) ---------------- */

  .patch-trigger {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 18px;
    height: 18px;
    background: rgba(20, 23, 28, 0.85);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    z-index: 6;
    transition: border-color 80ms ease-out, background 80ms ease-out;
  }
  .patch-trigger:hover,
  .patch-trigger[aria-expanded='true'] {
    border-color: var(--accent);
    background: rgba(0, 240, 255, 0.08);
  }
  .patch-trigger:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .trigger-glyph {
    position: relative;
    width: 12px;
    height: 12px;
    display: inline-block;
  }
  .trigger-glyph .prong {
    position: absolute;
    top: 1px;
    width: 2px;
    height: 5px;
    background: var(--cable-audio);
    border-radius: 1px;
  }
  .trigger-glyph .prong:nth-child(1) {
    left: 3px;
  }
  .trigger-glyph .prong:nth-child(2) {
    left: 7px;
  }
  .trigger-glyph .stem {
    position: absolute;
    bottom: 1px;
    left: 4px;
    width: 4px;
    height: 6px;
    background: var(--cable-audio);
    border-radius: 1px;
  }

  /* ---------------- Popover panel ---------------- */

  .patch-panel {
    position: absolute;
    top: 28px;
    left: 4px;
    background: rgba(14, 17, 22, 0.97);
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    color: var(--text);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
    padding: 8px 10px 10px;
    /* Closed state: hide visually but keep handles in DOM (I/O spec test
     * needs to find them). Opacity + pointer-events keeps the geometry
     * intact for getBoundingClientRect; transform pulls the visual
     * panel offscreen so it doesn't intercept hover. */
    opacity: 0;
    pointer-events: none;
    transform: translateX(-8px);
    transition: opacity 120ms ease-out, transform 120ms ease-out;
    max-height: 70vh;
    overflow-y: auto;
    z-index: 10;
  }
  .patch-panel.open {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }

  .panel-section + .panel-section {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #1f242c;
  }
  .section-title {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 4px;
    position: sticky;
    top: -8px;
    background: inherit;
    padding-top: 4px;
    z-index: 1;
  }
  .subgroup-title {
    font-size: 0.55rem;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 6px 0 2px;
  }
  .row-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* ---------------- Panel rows ---------------- */
  /*
   * Each row is `position: relative` so the absolutely-positioned Handle
   * inside it lands at the row's leading or trailing edge. Row layout is
   * a flex line with [stripe | label | handle] for inputs and
   * [handle | label | stripe] for outputs.
   */
  .panel-row {
    position: relative;
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 16px 0 12px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    color: var(--text);
  }
  .panel-row.right {
    padding: 0 12px 0 16px;
    justify-content: flex-end;
  }
  .panel-row .row-stripe {
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 1px;
    background: var(--row-cable, var(--cable-audio));
  }
  .panel-row .row-stripe.right {
    left: auto;
    right: 0;
  }
  .panel-row .row-label {
    flex: 1;
    text-align: left;
  }
  .panel-row .row-label.right {
    text-align: right;
  }

  /* ---------------- Handle positioning ---------------- */
  /*
   * Default xyflow handle styling (in routes/global.css) is a 12x12 ringed
   * dot. Inside our panel rows, the handle anchors at the row's leading
   * (left) or trailing (right) edge.
   */
  .patch-panel .panel-row :global(.svelte-flow__handle) {
    position: absolute !important;
    top: 50% !important;
    transform: translateY(-50%);
  }
  .patch-panel .panel-row :global(.svelte-flow__handle.target),
  .patch-panel .panel-row:not(.right) :global(.svelte-flow__handle) {
    left: -7px !important;
    right: auto !important;
  }
  .patch-panel .panel-row.right :global(.svelte-flow__handle),
  .patch-panel .panel-row :global(.svelte-flow__handle.source) {
    left: auto !important;
    right: -7px !important;
  }

  /* ---------------- Collapsed-state handle stacking ---------------- */
  /*
   * When the panel is closed, ALL handles inside it are stacked at the
   * affordance corner. Edges therefore visually anchor to top-left.
   * pointer-events:none stops a stray click on the stack of invisible
   * handles from starting a connect-drag (the user must hover-open first).
   *
   * Specificity hack: we need higher specificity than the open-state row
   * rules above. Doubling the .patch-panel class gets us there without
   * adding a chain of arbitrary parents.
   */
  .patch-panel.patch-panel:not(.open) .panel-row :global(.svelte-flow__handle),
  .patch-panel.patch-panel:not(.open) .panel-row.right :global(.svelte-flow__handle) {
    position: absolute !important;
    left: -16px !important;
    top: -16px !important;
    right: auto !important;
    transform: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
</style>
