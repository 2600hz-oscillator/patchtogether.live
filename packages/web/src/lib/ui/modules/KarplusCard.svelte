<script lang="ts">
  // KarplusCard — extended Karplus-Strong string/harp voice. Two-band
  // layout (kickdrum-family chrome):
  //
  //   ┌───────── STRING ─────────┬──────── EXCITER ────────┐
  //   │ Tune Decay Bright Stiff  │ Color Burst Pos         │
  //   ├──────────────────────────┴──────┬───────── OUT ────┤
  //   │ [ STRIKE ]  (audition trigger)  │ Level            │
  //   └─────────────────────────────────┴──────────────────┘
  //
  // The STRIKE button fires one canonical trigger pulse at the voice via
  // the engine handle's `manualTrigger` read key (the samsloop seam) — an
  // audition pluck that works with nothing patched. It is the SAME ONE seam
  // the RACKLINE face's `karplus-strike` action cell calls
  // (manual-strike-actions → the factory's `manualTrigger` read key → a
  // host-side ConstantSource on the worklet's trigger input), so there is one
  // implementation and both surfaces make exactly the same sound.

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { karplusDef } from '$lib/audio/modules/karplus';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec } from './card-kit';
  import { fireManualStrike } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live } = cardParams(karplusDef, () => id, () => node);

  // ⚠ RANGE/CURVE/UNITS COME FROM THE DEF, NEVER RE-TYPED HERE. This card used
  // to hardcode all eight (`min={55} max={1760} curve="log"` …). They agreed
  // with karplusDef value-for-value, so it was a LATENT divergence rather than
  // a live one — but every gate that could catch it (contract-lock,
  // module-docs-lint, the range assertions) reads the DEF, so a later edit to
  // either copy would have shipped invisibly. That is the backdraft class in
  // CLAUDE.md, and `paramSpec` (card-kit) exists for exactly it: it THROWS on
  // an unknown id, so a param rename fails loudly at card init.
  //
  // The `label`s below are the one thing that stays card-side, deliberately:
  // they are 3–4 char ABBREVIATIONS ("Dec", "Brt") sized for a 7-fader row,
  // where the def's labels ("Decay", "Bright") are authored for the shell's
  // wider cells and the rear holes. Different surface, different budget — not
  // a contract divergence, and importing them here would move a committed VRT
  // baseline for a cosmetic.
  const P = {
    tune:       paramSpec(karplusDef, 'tune'),
    decay:      paramSpec(karplusDef, 'decay'),
    brightness: paramSpec(karplusDef, 'brightness'),
    position:   paramSpec(karplusDef, 'position'),
    stiffness:  paramSpec(karplusDef, 'stiffness'),
    color:      paramSpec(karplusDef, 'color'),
    burst:      paramSpec(karplusDef, 'burst'),
    level:      paramSpec(karplusDef, 'level'),
  } as const;

  let tune       = $derived(paramVal('tune'));
  let decay      = $derived(paramVal('decay'));
  let brightness = $derived(paramVal('brightness'));
  let position   = $derived(paramVal('position'));
  let stiffness  = $derived(paramVal('stiffness'));
  let color      = $derived(paramVal('color'));
  let burst      = $derived(paramVal('burst'));
  let level      = $derived(paramVal('level'));

  // Manual STRIKE — audition pluck. The flash follows the TRUTH (whether a
  // strike actually fired) rather than the click, so a press before the audio
  // gate boots does not pretend to have plucked anything.
  let strikePulse = $state(false);
  function strike(): void {
    if (!fireManualStrike(id)) return;
    strikePulse = true;
    setTimeout(() => { strikePulse = false; }, 120);
  }

  // Rear PatchPanel — sectioned to MIRROR the on-card control-group headers:
  // each per-control CV jack sits under the same header as its knob (STRING /
  // EXCITER / OUT), the external STRIKE trigger lands under STRIKE, and the
  // global performance inputs (pitch / accent / damp) collect in a trailing
  // PATCH section alongside the audio OUT.
  const stringCv: PortDescriptor[] = [
    { id: 'tune_cv',   label: 'TUNE', cable: 'cv' },
    { id: 'decay_cv',  label: 'DEC',  cable: 'cv' },
    { id: 'bright_cv', label: 'BRT',  cable: 'cv' },
    { id: 'stiff_cv',  label: 'STF',  cable: 'cv' },
  ];
  const exciterCv: PortDescriptor[] = [
    { id: 'color_cv',    label: 'COL',  cable: 'cv' },
    { id: 'burst_cv',    label: 'BRST', cable: 'cv' },
    { id: 'position_cv', label: 'POS',  cable: 'cv' },
  ];
  const strikeInputs: PortDescriptor[] = [
    { id: 'trigger_in', label: 'TRIG', cable: 'gate' },
  ];
  const outInputs: PortDescriptor[] = [
    { id: 'level_cv', label: 'LVL', cable: 'cv' },
  ];
  const outOutputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'audio' },
  ];
  const patchInputs: PortDescriptor[] = [
    { id: 'pitch',     label: 'V/OCT', cable: 'pitch' },
    { id: 'accent_in', label: 'ACC',   cable: 'cv' },
    { id: 'damp_in',   label: 'DAMP',  cable: 'gate' },
  ];

  const sections = [
    { label: 'STRING',  inputs: stringCv },
    { label: 'EXCITER', inputs: exciterCv },
    { label: 'STRIKE',  inputs: strikeInputs },
    { label: 'OUT',     inputs: outInputs, outputs: outOutputs },
    { label: 'PATCH',   inputs: patchInputs },
  ];
</script>

<div class="mod-card karplus-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="KARPLUS" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={430}>
    <!-- ── band 1: STRING · EXCITER ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>STRING</header>
          <div class="fader-row">
            <NeonFader value={tune}       min={P.tune.min}       max={P.tune.max}       curve={P.tune.curve}       units={P.tune.units}  defaultValue={defaultFor('tune')}       label="Tune" onchange={set('tune')}       moduleId={id} paramId="tune"       readLive={live('tune')} />
            <NeonFader value={decay}      min={P.decay.min}      max={P.decay.max}      curve={P.decay.curve}      units={P.decay.units} defaultValue={defaultFor('decay')}      label="Dec"  onchange={set('decay')}      moduleId={id} paramId="decay"      readLive={live('decay')} />
            <NeonFader value={brightness} min={P.brightness.min} max={P.brightness.max} curve={P.brightness.curve}                       defaultValue={defaultFor('brightness')} label="Brt"  onchange={set('brightness')} moduleId={id} paramId="brightness" readLive={live('brightness')} />
            <NeonFader value={stiffness}  min={P.stiffness.min}  max={P.stiffness.max}  curve={P.stiffness.curve}                        defaultValue={defaultFor('stiffness')}  label="Stf"  onchange={set('stiffness')}  moduleId={id} paramId="stiffness"  readLive={live('stiffness')} />
          </div>
        </div>
        <div class="group">
          <header>EXCITER</header>
          <div class="fader-row">
            <NeonFader value={color}    min={P.color.min}    max={P.color.max}    curve={P.color.curve}    defaultValue={defaultFor('color')}    label="Col"  onchange={set('color')}    moduleId={id} paramId="color"    readLive={live('color')} />
            <NeonFader value={burst}    min={P.burst.min}    max={P.burst.max}    curve={P.burst.curve}    defaultValue={defaultFor('burst')}    label="Brst" onchange={set('burst')}    moduleId={id} paramId="burst"    readLive={live('burst')} />
            <NeonFader value={position} min={P.position.min} max={P.position.max} curve={P.position.curve} defaultValue={defaultFor('position')} label="Pos"  onchange={set('position')} moduleId={id} paramId="position" readLive={live('position')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 2: STRIKE · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide strike-group">
          <header>STRIKE</header>
          <!-- The `karplus-strike` control family (one member). The testid
               follows the DOCUMENTED member convention
               `${testidPrefix}-${nodeId}-${i}` (graph/types ControlFamily) —
               it used to be the bare prefix, which passed module-docs-lint
               only because that grep is substring-presence-only. -->
          <button
            class="strike"
            class:pulse={strikePulse}
            onclick={strike}
            data-testid={`karplus-strike-${id}-1`}
            title="Audition: pluck the string once (same as a trigger_in rising edge)"
          >⟋ PLUCK</button>
        </div>
        <div class="group">
          <header>OUT</header>
          <div class="fader-row">
            <NeonFader value={level} min={P.level.min} max={P.level.max} curve={P.level.curve} units={P.level.units} defaultValue={defaultFor('level')} label="Lvl" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .karplus-card { width: 450px; min-height: 240px; }
  .karplus-card .band {
    padding: 6px 12px 8px;
    border-top: 1px solid #1d1f25;
  }
  .karplus-card .band:first-of-type { border-top: none; }
  .karplus-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .karplus-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .karplus-card .group.wide { flex: 1.5; }
  .karplus-card .group:last-child { border-right: none; padding-right: 0; }
  .karplus-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #7fd4a8;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .karplus-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .karplus-card .strike-group { display: flex; flex-direction: column; }
  .karplus-card .strike {
    align-self: flex-start;
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
    letter-spacing: 1px;
    padding: 10px 18px;
    margin: 6px 0;
    background: #14151a;
    color: #7fd4a8;
    border: 1px solid #2a2d36;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .karplus-card .strike:active,
  .karplus-card .strike.pulse {
    color: #0e1013;
    background: #7fd4a8;
    border-color: #7fd4a8;
  }
</style>
