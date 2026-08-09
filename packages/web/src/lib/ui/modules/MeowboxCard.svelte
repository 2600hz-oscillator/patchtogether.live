<script lang="ts">
  // MeowboxCard — the classic-canvas face of the cat-vocal voice.
  //
  // ⚠ RANGES COME FROM THE DEF, NOT FROM THIS FILE. Every `min`/`max`/
  // `defaultValue`/`curve` below reads through `paramSpec(meowboxDef, id)`, the
  // ringback/adsr/snaredrum route. They agreed before this change — but agreeing
  // is not the bar, because nothing STOPS them diverging: the def-reading gates
  // (contract-lock, module-docs-lint, the face lint) are all structurally blind
  // to what a card types, which is the whole "a CARD can silently disagree with
  // its DEF" class in CLAUDE.md. Now the divergence is unrepresentable.
  // `card-range-source.test.ts` pins it at the SOURCE level.
  //
  // ⚠ `label` AND `units` ARE DELIBERATELY STILL LITERAL, and the four entries
  // in `card-def-debt.ts` (`pitch.label`, `decay.label`, `level.label`,
  // `pitch.units`) stay. Binding them flips the visible text to `Ptch`/`Dcy`/
  // `Lvl` and the suffix to `semi`, which REPAINTS a card in
  // `STRICT_VRT_MODULES` — the required `vrt-strict` lane, on both platforms.
  // That is a vocabulary decision that deserves its own PR, not a rider.
  //
  // ⚠ THE MEOW PAD IS PRESS-AND-HOLD, and that is the def's contract rather than
  // a style choice. `gate` is declared `edge: 'gate'` and the DSP's `ampEnv` is
  // an `en.adsr` sustaining at 0.4 — the voice sounds WHILE the level is high.
  // A one-shot here would fire the shared 5 ms trigger pulse and release the
  // envelope 5 ms into a 400 ms tail: a blip, not a meow. It calls the SAME seam
  // the RACKLINE shell's `meowbox-meow-{n}` cell calls (manual-strike-actions →
  // the factory's `manualGate` read key → a host-side ConstantSource summed into
  // the gate channel), so there is one implementation and a patched cable keeps
  // working alongside it. Nothing is written to the graph.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { meowboxDef } from '$lib/audio/modules/meowbox';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import { setManualGate } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(meowboxDef, () => id, () => node);

  /** The ONE source for every range on this card. `paramSpec` THROWS on an
   *  unknown id, which is also what retires the old positional
   *  `meowboxDef.params[0]!` reads — a param reorder used to silently rebind
   *  them. */
  const P = {
    pitch: paramSpec(meowboxDef, 'pitch'),
    morph: paramSpec(meowboxDef, 'morph'),
    decay: paramSpec(meowboxDef, 'decay'),
    level: paramSpec(meowboxDef, 'level'),
  } as const;

  let pitch = $derived(paramVal('pitch'));
  let morph = $derived(paramVal('morph'));
  let decay = $derived(paramVal('decay'));
  let level = $derived(paramVal('level'));

  // ── THE AUDITION (the `meowbox-meow` control family, one member).
  // Before this the card could make NO sound at all without a gate patched in —
  // `g = 0` gives `ampEnv = 0` and both channels are bit-zero.
  //
  // The five release handlers are not belt-and-braces: a pointer that leaves the
  // pad, a cancelled gesture and a blurred window are all releases the `up`
  // handler alone never sees, and a gate left open is a cat that never stops.
  // (`setManualGate` installs window-level panic listeners for the cases even
  // these miss — a deleted node, a hidden tab.) The `held` guard makes the close
  // idempotent, so an `up` after a `leave` is a no-op rather than a second edge.
  let holding = $state(false);
  function meowDown(): void {
    holding = true;
    setManualGate(id, true);
  }
  function meowUp(): void {
    if (!holding) return;
    holding = false;
    setManualGate(id, false);
  }

  const inputs = portsFromDef(meowboxDef.inputs);
  const outputs = portsFromDef(meowboxDef.outputs);
</script>

<div class="mod-card meowbox-card">
  <div class="ear ear-left"></div>
  <div class="ear ear-right"></div>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MEOWBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={pitch} min={P.pitch.min} max={P.pitch.max} defaultValue={P.pitch.defaultValue} label="Pitch"  units="st" curve={P.pitch.curve} onchange={set('pitch')} moduleId={id} paramId="pitch" readLive={live('pitch')} />
      <Knob value={morph} min={P.morph.min} max={P.morph.max} defaultValue={P.morph.defaultValue} label="Morph"             curve={P.morph.curve} onchange={set('morph')} moduleId={id} paramId="morph" readLive={live('morph')} />
      <Knob value={decay} min={P.decay.min} max={P.decay.max} defaultValue={P.decay.defaultValue} label="Decay"  units="s"  curve={P.decay.curve} onchange={set('decay')} moduleId={id} paramId="decay" readLive={live('decay')} />
      <Knob value={level} min={P.level.min} max={P.level.max} defaultValue={P.level.defaultValue} label="Level"             curve={P.level.curve} onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
    </div>
    <!-- The `meowbox-meow` control family (one member). The testid carries the
         family's declared `testidPrefix`, which module-docs-lint greps for. -->
    <div class="meow-row">
      <button
        type="button"
        class="meow"
        class:held={holding}
        aria-pressed={holding}
        onpointerdown={meowDown}
        onpointerup={meowUp}
        onpointercancel={meowUp}
        onpointerleave={meowUp}
        onblur={meowUp}
        data-testid={`meowbox-meow-${id}-1`}
        title="Audition: HOLD to gate the voice (identical to holding the gate input high)"
      >MEOW</button>
    </div>
  </PatchPanel>
</div>

<style>
  .meowbox-card {
    width: 240px;
    overflow: visible;
  }
  .meowbox-card .ear {
    position: absolute;
    top: -16px;
    width: 0;
    height: 0;
    border-left: 14px solid transparent;
    border-right: 14px solid transparent;
    border-bottom: 22px solid var(--meowbox-ear-color, #6e8aa6);
  }
  .meowbox-card .ear-left {
    left: 30px;
    transform: rotate(-12deg);
  }
  .meowbox-card .ear-right {
    right: 30px;
    transform: rotate(12deg);
  }
  .meowbox-card .knob-row {
    margin-top: 32px;
    display: flex;
    justify-content: center;
    gap: 14px;
    padding: 0 16px;
    flex-wrap: wrap;
  }
  .meowbox-card .meow-row {
    display: flex;
    justify-content: center;
    padding: 10px 16px 2px;
  }
  .meowbox-card .meow {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid var(--cable-gate, rgb(255 255 255 / 0.2));
    border-radius: 4px;
    color: inherit;
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.14em;
    padding: 4px 18px;
    cursor: pointer;
    touch-action: none;
  }
  .meowbox-card .meow:hover {
    background: rgb(255 255 255 / 0.12);
  }
  .meowbox-card .meow.held {
    background: var(--cable-gate, rgb(255 255 255 / 0.3));
    color: #101418;
  }
</style>
