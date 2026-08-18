<script lang="ts">
  // The LEGACY (`?shell=legacy`) LFO card. The curated RACKLINE face lives on
  // the def (`lfoDef.face`) and is rendered by ModuleShell; this card is the
  // pre-shell surface and stays until the workflow shell is the only route.
  //
  // ⚠ EVERY NUMBER AND NAME HERE COMES FROM THE DEF. This card used to hand-type
  // all three ranges (`min={0.01} max={100} defaultValue={1}` …), its own
  // three-entry shape-anchor roster, and its own four output labels. None of
  // that is visible to contract-lock, module-docs-lint or the range assertions —
  // they all read the DEF — so a card/def divergence would have been silent
  // (the BackdraftCard ±1-into-±0.2 class, CLAUDE.md). The literals are gone;
  // `lfo-face-model.test.ts` greps this file to keep them gone.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { lfoDef } from '$lib/audio/modules/lfo';
  import { LFO_SHAPE_LANDMARKS } from '$lib/audio/modules/lfo-face-model';
  import { knobValueToFrac } from '$lib/ui/controls/knob-conic-model';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(lfoDef, () => id, () => node);

  /** The def's ParamDef for a control — the ONE source for its range, curve
   *  and default. A missing id is a programming error, not a runtime state. */
  const P = (pid: string): ParamDef => {
    const p = lfoDef.params.find((q) => q.id === pid);
    if (!p) throw new Error(`LfoCard: no ParamDef '${pid}' on lfoDef`);
    return p;
  };
  const rateP = P('rate');
  const shapeP = P('shape');
  const depthP = P('depth');

  let rate  = $derived(node?.params.rate  ?? rateP.defaultValue);
  let shape = $derived(node?.params.shape ?? shapeP.defaultValue);
  let depth = $derived(node?.params.depth ?? depthP.defaultValue);

  // The Fader's track marks, derived from the def's DECLARED morph anchors
  // (PF-10 landmarks) instead of a second hand-written roster. `frac` is the
  // anchor's position along the param range; the drawn glyph is picked from the
  // anchor's own name, so adding a fourth anchor to the def adds a fourth mark
  // here with no edit.
  // ⚠ NO `?? 'sine'` FALLBACK. A default here is a SILENT WRONG PICTURE: rename
  // an anchor (or add a fourth the roster doesn't draw) and the Fader paints a
  // sine at, say, the square position with every gate green — the landmark test
  // pins the roster but nothing ties the roster to this map. Throwing makes the
  // omission a boot-time programming error, which is what it is.
  const SHAPE_GLYPH_KINDS = ['sine', 'tri', 'saw', 'square'] as const;
  type ShapeGlyphKind = (typeof SHAPE_GLYPH_KINDS)[number];
  const glyphKind = (label: string): ShapeGlyphKind => {
    const k = SHAPE_GLYPH_KINDS.find((g) => g === label);
    if (!k) throw new Error(`LfoCard: no track glyph for shape landmark '${label}'`);
    return k;
  };
  const SHAPE_MARKS = LFO_SHAPE_LANDMARKS.map((l) => ({
    // The DEF's curve, not a linear assumption — the mark has to land where the
    // Fader actually puts that value, and `shape` being `linear` today is a
    // property of the def, not of this card.
    frac: knobValueToFrac(l.value, shapeP.min, shapeP.max, shapeP.curve),
    kind: glyphKind(l.label),
  }));

  // Port names come from the def's co-located `PortDef.label` (PF-4) — no
  // per-card override map, so the front card and the rear card cannot disagree.
  const inputs = portsFromDef(lfoDef.inputs);
  const outputs = portsFromDef(lfoDef.outputs);
</script>

<div class="mod-card lfo-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="LFO" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- 1u: Rate + Shape faders with the Depth KNOB to their right, one row. -->
    <div class="control-row">
      <NeonFader value={rate}  min={rateP.min}  max={rateP.max}  defaultValue={rateP.defaultValue}  label={rateP.label}  units={rateP.units ?? ''} curve={rateP.curve}  onchange={set('rate')}  readLive={live('rate')}  moduleId={id} paramId="rate" />
      <NeonFader value={shape} min={shapeP.min} max={shapeP.max} defaultValue={shapeP.defaultValue} label={shapeP.label} curve={shapeP.curve} onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_MARKS} moduleId={id} paramId="shape" />
      <Knob value={depth} min={depthP.min} max={depthP.max} defaultValue={depthP.defaultValue} label={depthP.label} curve={depthP.curve} onchange={set('depth')} readLive={live('depth')} moduleId={id} paramId="depth" />
    </div>
  </PatchPanel>
</div>

<style>
  .lfo-card .control-row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 18px;
    padding: 0 16px;
    margin-top: 12px;
  }
</style>
