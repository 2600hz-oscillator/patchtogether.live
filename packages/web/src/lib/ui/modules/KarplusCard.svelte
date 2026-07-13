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
  // audition pluck that works with nothing patched.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { karplusDef } from '$lib/audio/modules/karplus';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live, engineCtx } = cardParams(karplusDef, () => id, () => node);

  let tune       = $derived(paramVal('tune'));
  let decay      = $derived(paramVal('decay'));
  let brightness = $derived(paramVal('brightness'));
  let position   = $derived(paramVal('position'));
  let stiffness  = $derived(paramVal('stiffness'));
  let color      = $derived(paramVal('color'));
  let burst      = $derived(paramVal('burst'));
  let level      = $derived(paramVal('level'));

  // Manual STRIKE — audition pluck (momentary visual flash on the button).
  let strikePulse = $state(false);
  function strike(): void {
    const e = engineCtx.get();
    if (!e || !node) return;
    const trig = e.read(node, 'manualTrigger');
    if (typeof trig === 'function') {
      (trig as () => void)();
      strikePulse = true;
      setTimeout(() => { strikePulse = false; }, 120);
    }
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
            <Fader value={tune}       min={55}   max={1760} defaultValue={defaultFor('tune')}       label="Tune" units="Hz" curve="log"    onchange={set('tune')}       moduleId={id} paramId="tune"       readLive={live('tune')} />
            <Fader value={decay}      min={0.1}  max={10}   defaultValue={defaultFor('decay')}      label="Dec"  units="s"  curve="log"    onchange={set('decay')}      moduleId={id} paramId="decay"      readLive={live('decay')} />
            <Fader value={brightness} min={0}    max={1}    defaultValue={defaultFor('brightness')} label="Brt"             curve="linear" onchange={set('brightness')} moduleId={id} paramId="brightness" readLive={live('brightness')} />
            <Fader value={stiffness}  min={0}    max={1}    defaultValue={defaultFor('stiffness')}  label="Stf"             curve="linear" onchange={set('stiffness')}  moduleId={id} paramId="stiffness"  readLive={live('stiffness')} />
          </div>
        </div>
        <div class="group">
          <header>EXCITER</header>
          <div class="fader-row">
            <Fader value={color}    min={0}    max={1}   defaultValue={defaultFor('color')}    label="Col"  curve="linear" onchange={set('color')}    moduleId={id} paramId="color"    readLive={live('color')} />
            <Fader value={burst}    min={0.1}  max={4}   defaultValue={defaultFor('burst')}    label="Brst" curve="log"    onchange={set('burst')}    moduleId={id} paramId="burst"    readLive={live('burst')} />
            <Fader value={position} min={0.02} max={0.5} defaultValue={defaultFor('position')} label="Pos"  curve="linear" onchange={set('position')} moduleId={id} paramId="position" readLive={live('position')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 2: STRIKE · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide strike-group">
          <header>STRIKE</header>
          <button
            class="strike"
            class:pulse={strikePulse}
            onclick={strike}
            data-testid="karplus-strike"
            title="Audition: pluck the string once (same as a trigger_in rising edge)"
          >⟋ PLUCK</button>
        </div>
        <div class="group">
          <header>OUT</header>
          <div class="fader-row">
            <Fader value={level} min={-24} max={12} defaultValue={defaultFor('level')} label="Lvl" units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
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
