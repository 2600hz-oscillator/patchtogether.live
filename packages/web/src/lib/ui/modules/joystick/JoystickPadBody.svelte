<script lang="ts">
  // packages/web/src/lib/ui/modules/joystick/JoystickPadBody.svelte
  //
  // THE JOYSTICK PAD, at the head of the dock full view — the module's real
  // instrument, carried across the promotion.
  //
  // ── WHAT IT IS ────────────────────────────────────────────────────────────
  //
  // The XY pad exactly as `JoystickCard.svelte` implements it — jump-to-point
  // on pointerdown, pointer capture, the Y flip (drag UP = +y), rAF-coalesced
  // TRACKED commits (`createDragCommit`, one pump per axis) with a flush on
  // pointerup, `lostpointercapture` recovery, double-click re-centre to the
  // defaults, the crosshairs, and the dot with its `.active` drag glow — with
  // ONE subtraction against that card:
  //
  //   - the `x: 0.00  y: 0.00` readout row is GONE (owner ruling 2026-08-17:
  //     the resting faceplate paints no derived-state text; owner-decisions
  //     2026-08-31 item 11 names this module's row). The values live in this
  //     element's accessible name, the same place `XyPad.svelte` put them when
  //     #2038 deleted the generic pad's row.
  //
  // ⚠ NO SNAP-BACK (#1963, verbatim "1 - persist"): releasing the pointer
  // leaves the stick where you dropped it. The position is `node.params`, so
  // it survives a release, a dock collapse/LRU eviction, a reload and collab
  // sync — this component holds NO durable state of its own.
  //
  // ── ⚠ THIS BODY IS NOT A CELL (the two-ordinary-cells fallback) ───────────
  //
  // `pos_x`/`pos_y` rank as two ordinary knob cells; at the dock those cells
  // render in the band BELOW this body and they are the parity-credited
  // controls (and the MIDI-learn / Electra / control-surface anchors — the
  // per-axis assign the hand-rolled legacy card never had). This pad is the
  // module's own ADDITIONAL surface — the twotracks redundancy, stated in the
  // shell-extension header — so it deliberately emits NO `data-control-params`,
  // NO `control-*` anchor testid and NO `data-cell-*` attributes: any of those
  // would double-count the axes in faces-parity's exact multiset or trip
  // `face-xy-body-source.test.ts`'s inverse leg. `joystick-face-model.test.ts`
  // pins the absences alongside the behaviours above.
  //
  // ⚠ NO SCREEN SWITCH and NO WATCH MARK: the video-screen ruling runs over
  // STRICT_FACES ∩ video defs and this is domain audio; `markWatched` is a
  // VideoEngine pull-set concept this module has no part in. And NO canvas —
  // the pad is DOM, which keeps the file out of the WebGL attest basis and is
  // what lets its `EXTENSION_BODY_ROLES` role (`control-grid`) hold.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import type { ModuleNode } from '$lib/graph/types';
  import { joystickDef, clampJoy } from '$lib/audio/modules/joystick';
  import { cardParams } from '../card-kit';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  const { set, defaultFor, paramVal } = cardParams(joystickDef, () => nodeId, () => node);

  // Synchronous drag values so the dot tracks the pointer at full rate while
  // the store commit is rAF-coalesced (the Knob/XyPad liveValue pattern);
  // at rest the store is the one truth, so a knob-cell turn, a MIDI CC or a
  // collab peer moves this dot too.
  let dragging = $state(false);
  let dragX = $state(0);
  let dragY = $state(0);
  let pos_x = $derived(clampJoy(dragging ? dragX : paramVal('pos_x')));
  let pos_y = $derived(clampJoy(dragging ? dragY : paramVal('pos_y')));

  const commitX = createDragCommit((v) => set('pos_x')(v));
  const commitY = createDragCommit((v) => set('pos_y')(v));
  onDestroy(() => {
    commitX.dispose();
    commitY.dispose();
  });

  let padEl: HTMLDivElement | null = $state(null);

  function writeFromPointer(ev: PointerEvent): void {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    const nx = clampJoy(px * 2 - 1);
    const ny = clampJoy(-(py * 2 - 1)); // flip: dragging UP is +y
    dragX = nx;
    dragY = ny;
    commitX.commit(nx);
    commitY.commit(ny);
  }
  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !padEl) return;
    dragging = true;
    dragX = pos_x;
    dragY = pos_y;
    padEl.setPointerCapture(ev.pointerId);
    writeFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    writeFromPointer(ev);
  }
  function onPointerUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    // Flush before teardown can cancel a trailing rAF — the final drag
    // position has to reach the store (#1963: it is the persisted value).
    commitX.flush();
    commitY.flush();
    try {
      padEl?.releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    // No snap-back: the stick stays where you put it.
  }
  function onLostCapture(): void {
    if (!dragging) return;
    dragging = false;
    commitX.flush();
    commitY.flush();
  }
  /** Double-click re-centres — the gesture that REPLACED the snap-back, on
   *  both the legacy card and the shared `XyPad`, so the three surfaces
   *  agree. Re-centre = the DEFAULTS, which `joystick-persist-model.test.ts`
   *  pins at (0, 0). */
  function onDblClick(): void {
    commitX.commit(defaultFor('pos_x'));
    commitY.commit(defaultFor('pos_y'));
    commitX.flush();
    commitY.flush();
  }

  // Dot position as a PERCENTAGE of the pad, aspect-free (the pad is square,
  // but a percentage needs no second derivation if that ever changes).
  let dotLeftPct = $derived(((pos_x + 1) / 2) * 100);
  let dotTopPct = $derived(((-pos_y + 1) / 2) * 100);

  // ⚠ `aria-label`, NOT `aria-valuetext` — this is `role="application"` (the
  // correct role for a 2-D manipulation surface that owns its own handling)
  // and `aria-valuetext` is only meaningful on a RANGE role. Same conclusion
  // `XyPad.svelte` and `QuadralogicalScreenBody.svelte` record. The format
  // mirrors XyPad's so a reader that speaks one pad can speak the other.
  function fmt(v: number): string {
    return v.toFixed(2);
  }
  let ariaLabel = $derived(`joystick pad: X ${fmt(pos_x)}, Y ${fmt(pos_y)}`);
</script>

<div class="joy-body" data-testid="joystick-face-body" data-node-id={nodeId}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
       — `role="application"` is exactly right for a control that OWNS its pointer handling.
       Svelte's rules do not model `application` as interactive. -->
  <div
    class="pad nodrag"
    bind:this={padEl}
    role="application"
    tabindex="0"
    aria-label={ariaLabel}
    data-testid="joystick-face-pad"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onlostpointercapture={onLostCapture}
    onpointercancel={onPointerUp}
    ondblclick={onDblClick}
  >
    <div class="crosshair-h"></div>
    <div class="crosshair-v"></div>
    <div
      class="dot"
      class:active={dragging}
      style="left: {dotLeftPct}%; top: {dotTopPct}%;"
      data-testid="joystick-face-dot"
    ></div>
  </div>
</div>

<style>
  .joy-body {
    display: flex;
    justify-content: center;
    padding: 8px 0 4px;
  }
  .pad {
    position: relative;
    width: 220px;
    height: 220px;
    background: #0c0e14;
    border: 1px solid var(--cable-cv);
    border-radius: 3px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad:active {
    cursor: grabbing;
  }
  .crosshair-h,
  .crosshair-v {
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
</style>
