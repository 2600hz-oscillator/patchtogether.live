<script lang="ts">
  // RingsCard — modal / sympathetic-string resonator card.
  //
  // ⚠ THIS CARD COULD NOT PLAY THE INSTRUMENT. RINGS is a BODY, not a voice:
  // with nothing patched and nothing struck the output is EXACTLY zero
  // (measured peak 0.000e+0 on both taps, both models). The card had a MODEL
  // button, six faders and a jack field and no way to excite any of it, so a
  // user who spawned it and turned every knob heard nothing with no indication
  // why. The STRUM button below fixes that. It is the SAME ONE SEAM the
  // faceplate's `rings-strum` action cell calls — `fireManualStrike` →
  // the factory's `manualTrigger` read key → a host-side ConstantSource on the
  // worklet's STRUM input — so there is one implementation, not two.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { ringsDef, RINGS_MODEL_NAMES } from '$lib/audio/modules/rings';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import { fireManualStrike } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, paramVal } = cardParams(ringsDef, () => id, () => node);

  /** The ONE source for every range on this card. These used to be six sets of
   *  re-typed literals sitting on the same screen as a correct
   *  `params.find(...).defaultValue` lookup — all six happened to agree, which
   *  is the hazard rather than the reprieve, and no gate could see a
   *  divergence because this card was not enrolled in RANGE_BOUND_CARDS. */
  const P = {
    note: paramSpec(ringsDef, 'note'),
    structure: paramSpec(ringsDef, 'structure'),
    brightness: paramSpec(ringsDef, 'brightness'),
    damping: paramSpec(ringsDef, 'damping'),
    position: paramSpec(ringsDef, 'position'),
    level: paramSpec(ringsDef, 'level'),
  } as const;

  let model      = $derived(paramVal('model'));
  let note       = $derived(paramVal('note'));
  let structure  = $derived(paramVal('structure'));
  let brightness = $derived(paramVal('brightness'));
  let damping    = $derived(paramVal('damping'));
  let position   = $derived(paramVal('position'));
  let level      = $derived(paramVal('level'));

  const MAX_MODEL = RINGS_MODEL_NAMES.length - 1;
  function clampModel(v: number): number {
    return Math.max(0, Math.min(MAX_MODEL, Math.round(v)));
  }
  let modelLabel = $derived(RINGS_MODEL_NAMES[clampModel(model)]);

  /** ⚠ WRITES THROUGH THE ORDINARY PARAM PATH. This used to reach into
   *  `patch.nodes[id]` and assign `t.params.model = next` — the dotted raw
   *  write that `mutate.guard`'s bracket-only `RAW_PARAM_WRITE` pattern was
   *  structurally unable to see. `set()` is the same seam every fader uses, so
   *  the model change is undoable and synced like everything else. */
  function cycleModel(): void {
    set('model')((clampModel(model) + 1) % (MAX_MODEL + 1));
  }

  // Manual STRUM — the audition. The flash follows the TRUTH (whether a strike
  // actually fired) rather than the click, so a press before the audio gate
  // boots does not pretend to have struck anything.
  let strumPulse = $state(false);
  function strum(): void {
    if (!fireManualStrike(id)) return;
    strumPulse = true;
    setTimeout(() => { strumPulse = false; }, 120);
  }

  const inputs = portsFromDef(ringsDef.inputs);
  const outputs = portsFromDef(ringsDef.outputs);
</script>

<div class="mod-card rings-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RINGS" />
  <div class="head-row">
    <button
      type="button"
      class="model-btn"
      data-testid="rings-model-btn"
      onclick={cycleModel}
    >
      <span class="model-btn-label">Model</span>
      <span class="model-btn-value" data-testid="rings-model-name">{modelLabel}</span>
    </button>
    <!-- The `rings-strum` control family (one member). The testid carries the
         nodeId + a 1-based member index, the shared family convention. -->
    <button
      type="button"
      class="strum-btn"
      class:pulse={strumPulse}
      data-testid={`rings-strum-${id}-1`}
      title="Audition: strike the resonator once (same as a strum rising edge)"
      onclick={strum}
    >≈ STRUM</button>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={note}       min={P.note.min}       max={P.note.max}       defaultValue={P.note.defaultValue}       label="Note"       units={P.note.units}       curve={P.note.curve}       onchange={set('note')} moduleId={id} paramId="note"       readLive={live('note')} />
      <Fader value={structure}  min={P.structure.min}  max={P.structure.max}  defaultValue={P.structure.defaultValue}  label="Structure"  units={P.structure.units}  curve={P.structure.curve}  onchange={set('structure')} moduleId={id} paramId="structure"  readLive={live('structure')} />
      <Fader value={brightness} min={P.brightness.min} max={P.brightness.max} defaultValue={P.brightness.defaultValue} label="Brightness" units={P.brightness.units} curve={P.brightness.curve} onchange={set('brightness')} moduleId={id} paramId="brightness" readLive={live('brightness')} />
      <Fader value={damping}    min={P.damping.min}    max={P.damping.max}    defaultValue={P.damping.defaultValue}    label="Damping"    units={P.damping.units}    curve={P.damping.curve}    onchange={set('damping')} moduleId={id} paramId="damping"    readLive={live('damping')} />
      <Fader value={position}   min={P.position.min}   max={P.position.max}   defaultValue={P.position.defaultValue}   label="Position"   units={P.position.units}   curve={P.position.curve}   onchange={set('position')} moduleId={id} paramId="position"   readLive={live('position')} />
      <Fader value={level}      min={P.level.min}      max={P.level.max}      defaultValue={P.level.defaultValue}      label="Level"      units={P.level.units}      curve={P.level.curve}      onchange={set('level')} moduleId={id} paramId="level"      readLive={live('level')} />
    </div>
  </PatchPanel>
  <OssAttribution author={ringsDef.ossAttribution?.author} />
</div>

<style>
  .rings-card { width: 360px; }
  .rings-card .head-row {
    display: flex;
    align-items: stretch;
    gap: 6px;
    /* Rack-compaction (#759): tighter margin to fit 1u. */
    margin: 1px 12px 2px;
  }
  .rings-card .model-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 1 1 auto;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 3px 10px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .rings-card .model-btn:hover {
    background: var(--bg-hover, #2a2a2a);
  }
  .rings-card .model-btn-label {
    color: var(--text-muted, #999);
  }
  .rings-card .model-btn-value {
    color: var(--text, #eee);
    font-weight: 600;
  }
  .rings-card .strum-btn {
    flex: 0 0 auto;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 3px 10px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
    white-space: nowrap;
  }
  .rings-card .strum-btn:hover {
    background: var(--bg-hover, #2a2a2a);
  }
  .rings-card .strum-btn.pulse {
    background: var(--cable-audio, #6cf);
    color: #000;
  }
  .rings-card .fader-row {
    /* Rack-compaction (#759): tighter top margin to fit 1u. */
    margin-top: 3px;
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 0 12px;
  }
</style>
