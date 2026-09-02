<script lang="ts">
  // packages/web/src/lib/ui/modules/moog956/Moog956RibbonStrip.svelte
  //
  // THE PLAYABLE STRIP — the 956's actual instrument, and the ONE
  // implementation of it that both face surfaces mount.
  //
  // ⚠ IT IS SHARED BECAUSE THE TWO SURFACES CAN BE ON SCREEN AT ONCE. A faced
  // module's lane tile and its open dock pane are two `ModuleShell` instances
  // for the same node, so the strip is mounted twice — which is exactly why
  // every testid is namespaced by `testidPrefix` (`moog956-tile-*` /
  // `moog956-face-*`) rather than shared: a duplicated testid throws every
  // strict locator, and audioIn's `AudioInSourceControls` records the same
  // finding.
  //
  // ⚠ IT IS NOT A FACE CELL, and the absence is load-bearing. `pos` ranks as a
  // FADER cell and `gate` as a momentary PAD; those are the parity-credited
  // controls and the MIDI-learn / Electra / control-surface anchors. This strip
  // is the module's own additional surface (the joystick/twotracks redundancy,
  // stated in the def), so it emits NO `control-*` anchor, NO
  // `data-control-params` and NO `data-cell-*` attribute — any of them would
  // double-count `pos` in faces-parity's exact multiset, which only fails in
  // the browser lane, half an hour late. `moog956-face-model.test.ts` pins the
  // absences.
  //
  // ⚠ NO CANVAS. The strip is DOM (a bordered box and a positioned wiper),
  // which is what lets its `EXTENSION_BODY_ROLES` role (`control-grid`) hold,
  // and — beyond the gate — keeps an audio utility out of the WebGL attest
  // basis, which is derived from CONTENT.
  //
  // ⚠ THE VALUE IS SPOKEN, NOT PAINTED. The legacy card's `{n} st` readout is
  // this promotion's named deletion (owner ruling 2026-08-17; owner-decisions
  // 2026-08-31 item 11). `role="slider"` genuinely has `aria-valuetext`, so
  // unlike the joystick pad one seam over this surface does not need to fall
  // back to `aria-label` for it.
  //
  // ⚠ `tabindex="-1"`, DELIBERATELY. `role="slider"` is an interactive role, so
  // the compiler requires a tabindex value; `0` would put the strip in the tab
  // order, and BARE TAB is the faceplate FLIP gesture (#1629). Focusable
  // programmatically, never by Tab — the owner's "no keyboard a11y additions"
  // ruling applied rather than skipped.
  //
  // Every write goes through `./ribbon-actions`, whose header carries the
  // pitch-before-gate ordering argument. Nothing about the gesture is
  // implemented here.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import type { ModuleNode } from '$lib/graph/types';
  import { clampRibbon, moog956Def } from '$lib/audio/modules/moog956';
  import { cardParams, paramSpec } from '../card-kit';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';
  import {
    ribbonPersistPos,
    ribbonPress,
    ribbonRelease,
    ribbonSemitoneText,
    ribbonSlide,
  } from './ribbon-actions';

  interface Props {
    nodeId: string;
    /** Namespaces every testid on this mount — see the header. */
    testidPrefix: string;
    /** The LANE variant: a shorter strip sized for a ~192 px tile. */
    compact?: boolean;
  }
  let { nodeId, testidPrefix, compact = false }: Props = $props();

  // ⚠ BOUND TO THE DEF, NOT RE-TYPED. The `aria-valuemin/max` below are the
  // slider's declared range, and the legacy card was fixed in this same diff to
  // stop carrying literals for exactly this reason. `card-range-source.test.ts`
  // scans only top-level `modules/*.svelte`, so nothing in this directory is
  // gated — which makes hardcoding `0`/`1` here precisely the "agrees by
  // inspection, gated by nothing" state the promotion set out to end.
  const POS = paramSpec(moog956Def, 'pos');

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  const { paramVal } = cardParams(moog956Def, () => nodeId, () => node);

  // Synchronous drag value so the wiper tracks the pointer at full rate while
  // the durable commit is rAF-coalesced (the Knob/XyPad/JoystickPadBody
  // pattern). At rest the STORE is the one truth, so a fader-cell throw, a
  // MIDI CC or a collab peer moves this wiper too.
  let dragging = $state(false);
  let dragPos = $state(0);
  let pos = $derived(clampRibbon(dragging ? dragPos : paramVal('pos')));
  let scale = $derived(paramVal('scale'));
  let offset = $derived(paramVal('offset'));

  // ONE tracked pump: N pointermoves per frame coalesce into ONE Y.Doc write.
  const commitPos = createDragCommit((v) => ribbonPersistPos(nodeId, v));
  onDestroy(() => {
    // ⚠ RELEASE BEFORE TEARDOWN. Pointer capture protects a MOVING pointer,
    // not a DELETED element: this strip unmounts mid-hold whenever the dock
    // pane closes, the module is deleted or the tile is LRU-evicted, and the
    // engine would otherwise keep the gate HIGH with no surface left to drop
    // it. (`setMomentaryParam`'s window-level panic listeners catch a lost
    // WINDOW, not a lost component.)
    if (dragging) ribbonRelease(nodeId);
    commitPos.dispose();
  });

  let ribbonEl: HTMLDivElement | null = $state(null);

  function posFromPointer(ev: PointerEvent): number {
    if (!ribbonEl) return 0;
    const rect = ribbonEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clampRibbon((ev.clientX - rect.left) / rect.width);
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !ribbonEl) return;
    dragging = true;
    dragPos = ribbonPress(nodeId, posFromPointer(ev));
    try {
      ribbonEl.setPointerCapture(ev.pointerId);
    } catch {
      /* a capture the browser refuses is not a reason to drop the note */
    }
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    const p = ribbonSlide(nodeId, posFromPointer(ev));
    dragPos = p;
    commitPos.commit(p);
  }
  function endGesture(ev?: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    // Flush BEFORE the release so the final position is durable even if a
    // trailing rAF never runs — the ribbon HOLDS its last pitch, so that
    // value is the thing the module promises to keep.
    commitPos.flush();
    ribbonRelease(nodeId);
    if (ev && ribbonEl) {
      try {
        ribbonEl.releasePointerCapture(ev.pointerId);
      } catch {
        /* */
      }
    }
  }

  let wiperPct = $derived(pos * 100);
  let valueText = $derived(ribbonSemitoneText(pos, scale, offset));
</script>

<div
  class="ribbon nodrag"
  class:compact
  bind:this={ribbonEl}
  role="slider"
  aria-label="956 ribbon"
  aria-valuemin={POS.min}
  aria-valuemax={POS.max}
  aria-valuenow={pos}
  aria-valuetext={valueText}
  tabindex="-1"
  data-testid="{testidPrefix}-ribbon"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endGesture}
  onpointercancel={endGesture}
  onlostpointercapture={() => endGesture()}
>
  <div
    class="wiper"
    class:active={dragging}
    style="left: {wiperPct}%;"
    data-testid="{testidPrefix}-wiper"
  ></div>
</div>

<style>
  /* ⚠ NO INTRINSIC WIDTH. `width: 100%` resolves as `auto` for the parent's
     intrinsic sizing, so the strip adds nothing to how wide the plate WANTS to
     be and then fills whatever it turns out to be (the AudioInSourceBody /
     AudioOutOutputBody shape). No floor and no number here that can go stale
     when a neighbour changes. */
  .ribbon {
    position: relative;
    width: 100%;
    min-width: 0;
    height: 26px;
    box-sizing: border-box;
    background: linear-gradient(180deg, #14161d 0%, #0a0c11 100%);
    border: 1px solid var(--cable-pitch, #c0a060);
    border-radius: 3px;
    touch-action: none;
    cursor: ew-resize;
    user-select: none;
    outline: none;
  }
  .ribbon.compact {
    height: 16px;
  }
  .wiper {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 4px;
    background: var(--cable-pitch, #e0c070);
    border-radius: 2px;
    transform: translateX(-50%);
    box-shadow: 0 0 6px rgba(224, 192, 112, 0.5);
    transition: box-shadow 80ms ease-out;
    pointer-events: none;
  }
  /* THE GATE LAMP, folded into the wiper. The card's separate LED was a
     colour mark rather than a readout, and a mark is what survives: while the
     finger is down the wiper burns. */
  .wiper.active {
    box-shadow: 0 0 12px rgba(224, 192, 112, 0.95);
  }
</style>
