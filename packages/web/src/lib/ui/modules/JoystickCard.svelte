<script lang="ts">
  // JoystickCard — XY pad emitting four bipolar CV outputs.
  //
  // The user drags a virtual stick inside a square pad. Pad-center maps
  // to (0, 0) CV; pad-edge maps to ±1. On pointer-up the stick snaps
  // back to center (set both params to 0) — a v1 simplification of
  // spring-back animation that keeps the implementation tiny.
  //
  // The Y axis is FLIPPED relative to screen-y so dragging UP yields
  // y = +1 (the musically/spatially expected direction for "up" cv).
  //
  // Visual: a small square with the stick indicator + crosshair guides.
  // The current x/y values are shown in a tiny readout below the pad.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { joystickDef, clampJoy } from '$lib/audio/modules/joystick';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  let pos_x = $derived(clampJoy(node?.params.pos_x ?? joystickDef.params[0]!.defaultValue));
  let pos_y = $derived(clampJoy(node?.params.pos_y ?? joystickDef.params[1]!.defaultValue));

  function write(x: number, y: number) {
    const t = patch.nodes[id];
    if (!t) return;
    t.params.pos_x = clampJoy(x);
    t.params.pos_y = clampJoy(y);
  }

  // ---- pointer drag ----
  let padEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);

  function updateFromPointer(ev: PointerEvent) {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;   // 0..1
    const py = (ev.clientY - rect.top) / rect.height;   // 0..1
    // Map [0..1] → [-1..+1]; flip Y so "up" = +y.
    const x = px * 2 - 1;
    const y = -(py * 2 - 1);
    write(x, y);
  }

  function onPointerDown(ev: PointerEvent) {
    if (!padEl) return;
    dragging = true;
    padEl.setPointerCapture(ev.pointerId);
    updateFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent) {
    if (!dragging) return;
    updateFromPointer(ev);
  }
  function onPointerUp(ev: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // Snap back to center on release (spring-back is a v1 simplification).
    write(0, 0);
  }

  // ---- pad geometry helpers ----
  const PAD_PX = 160;
  // Map pos in [-1..+1] → pixel offset within the pad. Y is flipped
  // (screen +y is "down", our +y is "up").
  let dotX = $derived(((pos_x + 1) / 2) * PAD_PX);
  let dotY = $derived(((-pos_y + 1) / 2) * PAD_PX);

  function fmt(v: number): string {
    return v.toFixed(2);
  }

  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'x',  label: 'X',  cable: 'cv' },
    { id: 'y',  label: 'Y',  cable: 'cv' },
    { id: 'nx', label: 'NX', cable: 'cv' },
    { id: 'ny', label: 'NY', cable: 'cv' },
  ];
</script>

<div class="mod-card joystick-card" data-testid="joystick-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="JOYSTICK" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="pad-wrap">
      <div
        class="pad nodrag"
        bind:this={padEl}
        style="width: {PAD_PX}px; height: {PAD_PX}px;"
        role="application"
        aria-label="Joystick XY pad"
        data-testid="joystick-pad"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <div class="crosshair-h"></div>
        <div class="crosshair-v"></div>
        <div
          class="dot"
          class:active={dragging}
          style="left: {dotX}px; top: {dotY}px;"
          data-testid="joystick-dot"
        ></div>
      </div>
      <div class="readout" data-testid="joystick-readout">
        <span>x: <strong>{fmt(pos_x)}</strong></span>
        <span>y: <strong>{fmt(pos_y)}</strong></span>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .joystick-card {
    width: 220px;
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .pad-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin: 6px auto 4px;
  }
  .pad {
    position: relative;
    background: #0c0e14;
    border: 1px solid var(--cable-cv);
    border-radius: 3px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad:active { cursor: grabbing; }
  .crosshair-h, .crosshair-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .crosshair-h {
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    transform: translateY(-0.5px);
  }
  .crosshair-v {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-0.5px);
  }
  .dot {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--cable-cv);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 8px rgba(120, 200, 255, 0.4);
    transition: box-shadow 80ms ease-out;
    pointer-events: none;
  }
  .dot.active {
    box-shadow: 0 0 14px rgba(120, 200, 255, 0.8);
  }
  .readout {
    display: flex;
    gap: 12px;
    font-size: 0.72rem;
    color: var(--text-dim, #aaa);
    font-variant-numeric: tabular-nums;
  }
  .readout strong { color: var(--text); font-weight: 500; }
</style>
