<script lang="ts">
  // JoystickCard — XY pad emitting four bipolar CV outputs.
  //
  // ⚠ THIS IS THE LEGACY SURFACE (and this header has now been wrong in BOTH
  // directions, so date every claim). joystick entered STRICT_FACES on
  // 2026-09-01 — the owner's two-ordinary-cells fallback (owner-decisions
  // 2026-08-31 item 2): the lane tile and the dock bands paint `pos_x`/`pos_y`
  // as two plain knob cells, and the real pad is the `joystick` extension's
  // `fullViewBody` (`joystick/JoystickPadBody.svelte`), which ports THIS
  // file's drag contract. This card still paints in the LANE under
  // `?shell=legacy`, so it must keep working — but the dock full view switches
  // on STRICT_FACES alone, so post-promotion the dock mounts the face even
  // under `?shell=legacy`, and the default shell mounts this card nowhere.
  //
  // The old #1974 refusal ("a face here resolves to ZERO lane controls,
  // because both params are axes of one pad") was about the `xyPads` shape,
  // and it still stands — on the SHAPE. The promotion declares no `xyPads`;
  // `module-face-lint` keeps denying the pad-only shape via its synthetic
  // `joystick-shaped-fixture`, which reads nothing from the live def.
  //
  // The user drags a virtual stick inside a square pad. Pad-center maps to
  // (0, 0) CV; pad-edge maps to ±1.
  //
  // ⚠ NO SNAP-BACK. Releasing the pointer leaves the stick where you dropped
  // it (owner ruling, 2026-08-19 on #1963, verbatim "1 - persist"), which is
  // what `XyPad.svelte` has always done and what makes this module's own
  // "it survives a patch reload" promise true for the first time.
  //
  // ⚠ THE WRITES ARE rAF-COALESCED AND TRACKED. They used to go straight into
  // `patch.nodes[id].params` on every pointermove — a ledgered raw-write DEBT
  // whose stated remedy was "the transient-first treatment". `createDragCommit`
  // IS that treatment (it is what Fader/Knob/XyPad use), so the debt is PAID
  // HERE, in the artifact, and the ledger entry is deleted in the same diff.
  // Deleting the entry alone would have been RED in the other direction: the
  // guard is anchored to the source, so an unlisted raw write fails it.
  //
  // The Y axis is FLIPPED relative to screen-y so dragging UP yields
  // y = +1 (the musically/spatially expected direction for "up" cv).
  //
  // Visual: a small square with the stick indicator + crosshair guides.
  // The current x/y values are shown in a tiny readout below the pad. (The
  // 2026-08-17 resting-decimal ruling is about FACEPLATES; the legacy cards
  // are untouched. On the FACE the values live in the pad body's `aria-label`
  // — NOT `aria-valuetext`, which only exists on range roles; the def's #2038
  // note records the same wrong-attribute correction — and on the knob cells'
  // `aria-valuetext`, where the role really has one.)

  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { joystickDef, clampJoy } from '$lib/audio/modules/joystick';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set } = cardParams(joystickDef, () => id, () => node);

  let pos_x = $derived(clampJoy(node?.params.pos_x ?? joystickDef.params[0]!.defaultValue));
  let pos_y = $derived(clampJoy(node?.params.pos_y ?? joystickDef.params[1]!.defaultValue));

  // One pump per axis, exactly as XyPad does it: N pointermoves per frame
  // coalesce into ONE tracked param write each.
  const commitX = createDragCommit((v) => set('pos_x')(v));
  const commitY = createDragCommit((v) => set('pos_y')(v));
  onDestroy(() => { commitX.dispose(); commitY.dispose(); });

  function write(x: number, y: number) {
    commitX.commit(clampJoy(x));
    commitY.commit(clampJoy(y));
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
    // Flush before teardown can cancel a trailing rAF — the final drag
    // position has to reach the store, exactly as XyPad's pointerup does.
    commitX.flush();
    commitY.flush();
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: a 2-D position control stays where you put it (#1963).
  }

  /** Double-click re-centres — the gesture that REPLACES the snap-back, and the
   *  same one `XyPad.svelte` binds, so the two surfaces agree. */
  function onDblClick() {
    commitX.commit(0);
    commitY.commit(0);
    commitX.flush();
    commitY.flush();
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

  const inputs = portsFromDef(joystickDef.inputs);
  const outputs = portsFromDef(joystickDef.outputs);
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
        ondblclick={onDblClick}
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
  }  .pad-wrap {
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
