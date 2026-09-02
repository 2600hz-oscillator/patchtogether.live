<script lang="ts">
  // moogafakkin 956 RIBBON CONTROLLER card.
  //
  // A horizontal touch-ribbon: press + slide along the strip to set a
  // continuous pitch CV; the gate goes HIGH while touched. Like the
  // hardware ribbon, lifting off HOLDS the last pitch (only the gate
  // falls) — the patched VCO stays at the last played note.
  //
  // ⚠ THIS IS THE LEGACY SURFACE. moog956 entered STRICT_FACES on 2026-09-02:
  // the lane tile and the dock bands paint `pos` (a FADER cell), `scale`,
  // `offset` and a momentary `gate` pad, and the real strip is the `moog956`
  // extension's `tileBody` (lane) + `fullViewBody` (dock). This card still
  // paints in the LANE under `?shell=legacy`, so it must keep working.
  //
  // ⚠ THE GESTURE IS NOT IMPLEMENTED HERE ANY MORE. Press / slide / release
  // all go through `./moog956/ribbon-actions`, the one seam all three surfaces
  // call, so a fix lands on every surface at once. Two things changed for this
  // card in the same move, and both were bugs rather than refactors:
  //
  //   1. THE RAW-WRITE DEBT IS PAID. `t.params.pos = …` on every pointermove
  //      was a ledgered raw write (`raw-write-ledger.ts`, kind `debt`, stated
  //      remedy "needs the transient-first treatment"). It is now a tracked,
  //      rAF-coalesced `createDragCommit` pump — the treatment named — and the
  //      ledger entry is DELETED in the same diff. Deleting the entry alone
  //      would have been red the other way: the guard is anchored to the
  //      source, so an unlisted raw write fails it.
  //   2. `gate` IS A PRESS, NOT A SAVED VALUE. It used to be written into the
  //      Y.Doc, which persists a stuck HIGH gate whenever the release edge
  //      never arrives (the card unmounts mid-hold — pointer capture protects
  //      a moving pointer, not a deleted element). It now goes through
  //      `setMomentaryParam`: engine only, panic-latched, never persisted. So
  //      the LED below reads the LOCAL finger state, which is what it always
  //      was in substance.
  //
  // ⚠ THE RANGES ARE BOUND TO THE DEF (`paramSpec`), not re-typed. The knobs
  // used to carry literal `min={0} max={5}` beside a def that declares the
  // same numbers — agreeing by inspection, gated by nothing, one edit from the
  // backdraft class. `card-range-source.test.ts` now holds this card.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog903aCard / Moog992Card.
  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { moog956Def, clampRibbon } from '$lib/audio/modules/moog956';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';
  import { clearStuckMomentaryParams } from './manual-strike-actions';
  import {
    ribbonPersistPos,
    ribbonPress,
    ribbonRelease,
    ribbonSemitoneText,
    ribbonSlide,
  } from './moog956/ribbon-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const { paramVal, set, live } = cardParams(moog956Def, () => id, () => node);

  const POS = paramSpec(moog956Def, 'pos');
  const SCALE = paramSpec(moog956Def, 'scale');
  const OFFSET = paramSpec(moog956Def, 'offset');

  // ---- ribbon pointer drag ----
  let ribbonEl: HTMLDivElement | null = $state(null);
  let touching = $state(false);
  let dragPos = $state(0);

  let pos = $derived(clampRibbon(touching ? dragPos : paramVal('pos')));
  let scale = $derived(paramVal('scale'));
  let offset = $derived(paramVal('offset'));

  // Live pitch readout, in semitones — the SAME formatter the face speaks on
  // its strip's `aria-valuetext`, so the two surfaces cannot disagree about
  // the number. (A legacy card printing a value is untouched by the
  // resting-text ruling, which is about faceplates.)
  let semitoneText = $derived(ribbonSemitoneText(pos, scale, offset));

  // One tracked pump: N pointermoves per frame → ONE Y.Doc write.
  const commitPos = createDragCommit((v) => ribbonPersistPos(id, v));
  onDestroy(() => {
    // Release before teardown: the card unmounts mid-hold on a dock swap or an
    // LRU eviction, and the engine would otherwise keep the gate HIGH with no
    // surface left to drop it.
    if (touching) ribbonRelease(id);
    commitPos.dispose();
  });

  // Repair a rack saved by an older build with the gate stuck HIGH. Under
  // `?shell=legacy` this card is the only surface, so ModuleShell's identical
  // effect never runs.
  $effect(() => {
    clearStuckMomentaryParams(id, moog956Def);
  });

  function posFromPointer(ev: PointerEvent): number {
    if (!ribbonEl) return 0;
    const rect = ribbonEl.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clampRibbon((ev.clientX - rect.left) / rect.width); // 0..1 across
  }

  function onPointerDown(ev: PointerEvent) {
    if (!ribbonEl) return;
    touching = true;
    dragPos = ribbonPress(id, posFromPointer(ev));
    try { ribbonEl.setPointerCapture(ev.pointerId); } catch { /* */ }
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: PointerEvent) {
    if (!touching) return;
    const p = ribbonSlide(id, posFromPointer(ev));
    dragPos = p;
    commitPos.commit(p);
  }
  function endGesture(ev?: PointerEvent) {
    if (!touching) return;
    touching = false;
    // Flush before the release: the ribbon HOLDS its last pitch, so the final
    // position is the thing the module promises to keep.
    commitPos.flush();
    ribbonRelease(id);
    if (ev) {
      try { ribbonEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    }
  }

  const RIBBON_PX = 200;
  let dotX = $derived(pos * RIBBON_PX);

  const inputs = portsFromDef(moog956Def.inputs);
  const outputs = portsFromDef(moog956Def.outputs);
</script>

<MoogPanel {id} {data} defaultLabel="956 Ribbon" width={240}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="ribbon-wrap">
      <div
        class="ribbon nodrag"
        bind:this={ribbonEl}
        style="width: {RIBBON_PX}px;"
        role="slider"
        aria-label="Ribbon controller"
        aria-valuemin={POS.min}
        aria-valuemax={POS.max}
        aria-valuenow={pos}
        aria-valuetext={semitoneText}
        tabindex="0"
        data-testid="moog956-ribbon"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={endGesture}
        onpointercancel={endGesture}
        onlostpointercapture={() => endGesture()}
      >
        <div
          class="wiper"
          class:active={touching}
          style="left: {dotX}px;"
          data-testid="moog956-wiper"
        ></div>
      </div>
      <div class="readout" data-testid="moog956-readout">
        <span class="gate-led" class:on={touching} aria-hidden="true"></span>
        <span>{semitoneText}</span>
      </div>
    </div>

    <div class="knob-row" data-testid="moog956-knobs">
      <Knob value={scale} min={SCALE.min} max={SCALE.max} defaultValue={SCALE.defaultValue} label="Scale" curve={SCALE.curve} onchange={set('scale')} moduleId={id} paramId="scale" readLive={live('scale')} />
      <Knob value={offset} min={OFFSET.min} max={OFFSET.max} defaultValue={OFFSET.defaultValue} label="Offset" curve={OFFSET.curve} onchange={set('offset')} moduleId={id} paramId="offset" readLive={live('offset')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .ribbon-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin: 6px auto 8px;
  }
  .ribbon {
    position: relative;
    height: 26px;
    background: linear-gradient(180deg, #2a2018 0%, #14100a 100%);
    border: 1px solid var(--cable-pitch, #c0a060);
    border-radius: 4px;
    touch-action: none;
    cursor: ew-resize;
    user-select: none;
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
  .wiper.active {
    box-shadow: 0 0 12px rgba(224, 192, 112, 0.9);
  }
  .readout {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: var(--text-dim, #b6a684);
    font-variant-numeric: tabular-nums;
  }
  .gate-led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3a3026;
    border: 1px solid #5a4a30;
  }
  .gate-led.on {
    background: var(--cable-gate, #ff5050);
    box-shadow: 0 0 8px var(--cable-gate, #ff5050);
  }
  .knob-row {
    display: flex;
    justify-content: center;
    gap: 18px;
    margin: 2px 0 4px;
  }
</style>
