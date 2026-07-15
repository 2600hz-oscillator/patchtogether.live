<script lang="ts">
  // SixstrumCard — the 6-string guitar/bass/harp instrument. Four fader bands
  // (karplus-family chrome) + three discrete selectors (Tuning / Dir / Chord)
  // with name readouts, and a STRUM audition button that barres all six
  // strings. The rear PatchPanel groups the 15 inputs per string (Strum+Mute)
  // plus a Play section (Poly / Chord / Accent) and the mono Out.
  //
  //   ┌───── STRINGS ─────┬─ TUNING ┐   ┌──── PICK ────┐
  //   │ Reg Ring Matl Pos Stf │ [guitar] │   Tone Grain Sprd Body │
  //   ├──────── ENVELOPE ─────────┤   ┌── STRUM ──┬─ OUT ─┐
  //   │ A  D  S  R  Mute          │   │ Strum [dir] [chord] │ Lvl [STRUM] │
  //   └───────────────────────────┘   └──────────┴───────┘

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { sixstrumDef } from '$lib/audio/modules/sixstrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live, engineCtx } = cardParams(sixstrumDef, () => id, () => node);

  let register    = $derived(paramVal('register'));
  let ring        = $derived(paramVal('ring'));
  let material    = $derived(paramVal('material'));
  let pickPos     = $derived(paramVal('pickPos'));
  let stiffness   = $derived(paramVal('stiffness'));
  let pickTone    = $derived(paramVal('pickTone'));
  let pickGrain   = $derived(paramVal('pickGrain'));
  let attack      = $derived(paramVal('attack'));
  let envDecay    = $derived(paramVal('envDecay'));
  let sustain     = $derived(paramVal('sustain'));
  let release     = $derived(paramVal('release'));
  let muteDepth   = $derived(paramVal('muteDepth'));
  let strumSpread = $derived(paramVal('strumSpread'));
  let strumDir    = $derived(paramVal('strumDir'));
  let spread      = $derived(paramVal('spread'));
  let body        = $derived(paramVal('body'));
  let level       = $derived(paramVal('level'));
  let tuning      = $derived(paramVal('tuning'));
  let quality     = $derived(paramVal('quality'));

  const TUNING_NAMES = ['guitar', 'bass', 'harp'];
  const DIR_NAMES = ['down', 'up', 'alt'];
  const QUALITY_NAMES = ['maj', 'min', 'dom7', 'maj7', 'min7', 'sus4', 'pow5', 'oct'];
  let tuningName  = $derived(TUNING_NAMES[Math.round(tuning)] ?? 'guitar');
  let dirName     = $derived(DIR_NAMES[Math.round(strumDir)] ?? 'down');
  let qualityName = $derived(QUALITY_NAMES[Math.round(quality)] ?? 'maj');

  // STRUM audition — barres all six strings (fires strum #1 via the manualTrigger seam).
  let strumPulse = $state(false);
  function strum(): void {
    const e = engineCtx.get();
    if (!e || !node) return;
    const trig = e.read(node, 'manualTrigger');
    if (typeof trig === 'function') {
      (trig as () => void)();
      strumPulse = true;
      setTimeout(() => { strumPulse = false; }, 140);
    }
  }

  // Rear PatchPanel — one section per string (its Strum trigger + Mute gate),
  // then a Play section (Poly / Chord / Accent) and the mono Out.
  const stringSections = Array.from({ length: 6 }, (_, i) => ({
    label: `Str ${i + 1}`,
    inputs: [
      { id: `strum${i + 1}`, label: 'STRM', cable: 'gate' },
      { id: `mute${i + 1}`, label: 'MUTE', cable: 'gate' },
    ] as PortDescriptor[],
  }));
  const playInputs: PortDescriptor[] = [
    { id: 'poly', label: 'POLY', cable: 'polyPitchGate' },
    { id: 'chord', label: 'CHORD', cable: 'pitch' },
    { id: 'accent', label: 'ACC', cable: 'cv' },
  ];
  const outOutputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'audio' }];

  const sections = [
    ...stringSections,
    { label: 'Play', inputs: playInputs },
    { label: 'Out', outputs: outOutputs },
  ];
</script>

<div class="mod-card sixstrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SIX STRUM" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={600}>
    <!-- ── band 1: STRINGS · TUNING ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>STRINGS</header>
          <div class="fader-row">
            <Fader value={register} min={-24} max={24} defaultValue={defaultFor('register')} label="Reg" units="st" curve="linear" onchange={set('register')} moduleId={id} paramId="register" readLive={live('register')} />
            <Fader value={ring}     min={0.1} max={10} defaultValue={defaultFor('ring')}     label="Ring" units="s" curve="log"   onchange={set('ring')}     moduleId={id} paramId="ring"     readLive={live('ring')} />
            <Fader value={material} min={0}   max={1}  defaultValue={defaultFor('material')} label="Matl"           curve="linear" onchange={set('material')} moduleId={id} paramId="material" readLive={live('material')} />
            <Fader value={pickPos}  min={0.02} max={0.5} defaultValue={defaultFor('pickPos')} label="Pos"          curve="linear" onchange={set('pickPos')}  moduleId={id} paramId="pickPos"  readLive={live('pickPos')} />
            <Fader value={stiffness} min={0}  max={1}  defaultValue={defaultFor('stiffness')} label="Stf"          curve="linear" onchange={set('stiffness')} moduleId={id} paramId="stiffness" readLive={live('stiffness')} />
          </div>
        </div>
        <div class="group sel-group">
          <header>TUNING</header>
          <div class="sel-readout" data-testid="sixstrum-tuning-name">{tuningName}</div>
          <Fader value={tuning} min={0} max={2} defaultValue={defaultFor('tuning')} label="Tun" curve="discrete" onchange={set('tuning')} moduleId={id} paramId="tuning" readLive={live('tuning')} />
        </div>
      </div>
    </section>

    <!-- ── band 2: PICK ── -->
    <section class="band">
      <div class="groups">
        <div class="group">
          <header>PICK</header>
          <div class="fader-row">
            <Fader value={pickTone}  min={0}   max={1} defaultValue={defaultFor('pickTone')}  label="Tone"  curve="linear" onchange={set('pickTone')}  moduleId={id} paramId="pickTone"  readLive={live('pickTone')} />
            <Fader value={pickGrain} min={0.1} max={4} defaultValue={defaultFor('pickGrain')} label="Grain" curve="log"    onchange={set('pickGrain')} moduleId={id} paramId="pickGrain" readLive={live('pickGrain')} />
            <Fader value={spread}    min={0}   max={1} defaultValue={defaultFor('spread')}    label="Sprd"  curve="linear" onchange={set('spread')}    moduleId={id} paramId="spread"    readLive={live('spread')} />
            <Fader value={body}      min={0}   max={1} defaultValue={defaultFor('body')}      label="Body"  curve="linear" onchange={set('body')}      moduleId={id} paramId="body"      readLive={live('body')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 3: ENVELOPE ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>ENVELOPE</header>
          <div class="fader-row">
            <Fader value={attack}   min={0.0005} max={5} defaultValue={defaultFor('attack')}   label="A"    units="s" curve="log"    onchange={set('attack')}   moduleId={id} paramId="attack"   readLive={live('attack')} />
            <Fader value={envDecay} min={0.001}  max={5} defaultValue={defaultFor('envDecay')} label="D"    units="s" curve="log"    onchange={set('envDecay')} moduleId={id} paramId="envDecay" readLive={live('envDecay')} />
            <Fader value={sustain}  min={0}      max={1} defaultValue={defaultFor('sustain')}  label="S"              curve="linear" onchange={set('sustain')}  moduleId={id} paramId="sustain"  readLive={live('sustain')} />
            <Fader value={release}  min={0.001}  max={5} defaultValue={defaultFor('release')}  label="R"    units="s" curve="log"    onchange={set('release')}  moduleId={id} paramId="release"  readLive={live('release')} />
            <Fader value={muteDepth} min={0}     max={1} defaultValue={defaultFor('muteDepth')} label="Mute"          curve="linear" onchange={set('muteDepth')} moduleId={id} paramId="muteDepth" readLive={live('muteDepth')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 4: STRUM · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>STRUM</header>
          <div class="fader-row">
            <Fader value={strumSpread} min={0} max={1} defaultValue={defaultFor('strumSpread')} label="Roll" curve="linear" onchange={set('strumSpread')} moduleId={id} paramId="strumSpread" readLive={live('strumSpread')} />
            <div class="sel-inline">
              <div class="sel-readout" data-testid="sixstrum-dir-name">{dirName}</div>
              <Fader value={strumDir} min={0} max={2} defaultValue={defaultFor('strumDir')} label="Dir" curve="discrete" onchange={set('strumDir')} moduleId={id} paramId="strumDir" readLive={live('strumDir')} />
            </div>
            <div class="sel-inline">
              <div class="sel-readout" data-testid="sixstrum-chord-name">{qualityName}</div>
              <Fader value={quality} min={0} max={7} defaultValue={defaultFor('quality')} label="Chord" curve="discrete" onchange={set('quality')} moduleId={id} paramId="quality" readLive={live('quality')} />
            </div>
            <button
              class="strum-btn"
              class:pulse={strumPulse}
              onclick={strum}
              data-testid="sixstrum-strum"
              title="Audition: strum all six strings (same as a strum #1 rising edge)"
            >⟋ STRUM</button>
          </div>
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
  .sixstrum-card { width: 620px; min-height: 300px; }
  .sixstrum-card .band {
    padding: 6px 12px 8px;
    border-top: 1px solid #1d1f25;
  }
  .sixstrum-card .band:first-of-type { border-top: none; }
  .sixstrum-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .sixstrum-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .sixstrum-card .group.wide { flex: 2.5; }
  .sixstrum-card .group:last-child { border-right: none; padding-right: 0; }
  .sixstrum-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #7fd4a8;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .sixstrum-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .sixstrum-card .sel-group { flex: 0.9; display: flex; flex-direction: column; align-items: center; }
  .sixstrum-card .sel-inline { display: flex; flex-direction: column; align-items: center; }
  .sixstrum-card .sel-readout {
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.5px;
    color: #7fd4a8;
    text-transform: uppercase;
    margin-bottom: 3px;
    min-height: 0.8rem;
  }
  .sixstrum-card .strum-btn {
    align-self: flex-end;
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
    letter-spacing: 1px;
    padding: 10px 16px;
    margin: 0 0 6px 4px;
    background: #14151a;
    color: #7fd4a8;
    border: 1px solid #2a2d36;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .sixstrum-card .strum-btn:active,
  .sixstrum-card .strum-btn.pulse {
    color: #0e1013;
    background: #7fd4a8;
    border-color: #7fd4a8;
  }
</style>
