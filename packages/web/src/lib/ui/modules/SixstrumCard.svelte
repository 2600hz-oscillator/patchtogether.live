<script lang="ts">
  // SixstrumCard — the 6-string guitar/bass/harp instrument. Compact TWO-BAND
  // layout (karplus-family chrome) so it fits its rack tier: each band packs
  // three width-weighted groups of faders, with the TUNING / STRUM-DIR / CHORD
  // discrete selectors shown as name readouts + a STRUM audition button. The
  // rear PatchPanel groups the inputs per string (Strum+Mute) + Poly/Chord/
  // Accent + the per-knob CV modulators (PICK: tone/grain/spread/body · STRUM:
  // roll/dir/chord) + the mono Out.
  //
  //   ┌ STRINGS ───────────────┬ PICK ──────────┬ TUNING ┐
  //   │ Reg Ring Matl Pos Stf   │ Tone Grn Spr Bdy│ [guitar]│
  //   ├ ENVELOPE ───────────────┼ STRUM ─────────┼ OUT ────┤
  //   │ A  D  S  R  Mute         │ Roll [dir][chd] ⟋│  Lvl   │
  //   └─────────────────────────┴────────────────┴────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { sixstrumDef } from '$lib/audio/modules/sixstrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';
  import { applySixstrumPreset, sixstrumModeName } from './sixstrum-preset-actions';

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

  const DIR_NAMES = ['down', 'up', 'alt'];
  const QUALITY_NAMES = ['maj', 'min', 'dom7', 'maj7', 'min7', 'sus4', 'pow5', 'oct'];
  let tuningName  = $derived(sixstrumModeName(tuning));
  let dirName     = $derived(DIR_NAMES[Math.round(strumDir)] ?? 'down');
  let qualityName = $derived(QUALITY_NAMES[Math.round(quality)] ?? 'maj');

  // MODE is a PRESET RECALL, not just a tuning switch: picking guitar/bass/harp
  // stamps the calibrated knob configuration onto the visible controls (the
  // three modes ARE knob states — "presets reflect knob states, no magic").
  // Includes `tuning` (which open strings) as one of the stamped values. After
  // a recall every knob is visible + tweakable; the modes are reachable, then
  // editable.
  //
  // The roster + the stamp now live in sixstrum-preset-actions (the dx7
  // precedent), so this knob and the RACKLINE shell's PRESET cell run the SAME
  // implementation — the shell face carried `tuning` but had no recall to call,
  // which left the three modes unreachable under `?shell=1`.
  // The `${testidPrefix}` for the declared `sixstrum-preset` control family is
  // emitted on the cell below (the docs gate greps the card for it).
  function setMode(v: number): void {
    applySixstrumPreset(id, v);
  }

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
  // Per-knob CV modulators, grouped under the on-card control headers (PICK ·
  // STRUM) they modulate — the karplus/kickdrum sectioned-rear-panel convention.
  const pickCvInputs: PortDescriptor[] = [
    { id: 'tone_cv', label: 'TONE', cable: 'cv' },
    { id: 'grain_cv', label: 'GRAIN', cable: 'cv' },
    { id: 'spread_cv', label: 'SPREAD', cable: 'cv' },
    { id: 'body_cv', label: 'BODY', cable: 'cv' },
  ];
  const strumCvInputs: PortDescriptor[] = [
    { id: 'strum_cv', label: 'ROLL', cable: 'cv' },
    { id: 'dir_cv', label: 'DIR', cable: 'cv' },
    { id: 'chord_cv', label: 'CHORD QUAL', cable: 'cv' },
  ];
  const outOutputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'audio' }];

  const sections = [
    ...stringSections,
    { label: 'Play', inputs: playInputs },
    { label: 'Pick', inputs: pickCvInputs },
    { label: 'Strum', inputs: strumCvInputs },
    { label: 'Out', outputs: outOutputs },
  ];
</script>

<div class="mod-card sixstrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SIX STRUM" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={720}>
    <!-- ── band 1: STRINGS · PICK · TUNING ── -->
    <section class="band">
      <div class="groups">
        <div class="group g-strings">
          <header>STRINGS</header>
          <div class="fader-row">
            <NeonFader value={register} min={-24} max={24} defaultValue={defaultFor('register')} label="Reg" units="st" curve="linear" onchange={set('register')} moduleId={id} paramId="register" readLive={live('register')} />
            <NeonFader value={ring}     min={0.1} max={10} defaultValue={defaultFor('ring')}     label="Ring" units="s" curve="log"   onchange={set('ring')}     moduleId={id} paramId="ring"     readLive={live('ring')} />
            <NeonFader value={material} min={0}   max={1}  defaultValue={defaultFor('material')} label="Matl"           curve="linear" onchange={set('material')} moduleId={id} paramId="material" readLive={live('material')} />
            <NeonFader value={pickPos}  min={0.02} max={0.5} defaultValue={defaultFor('pickPos')} label="Pos"          curve="linear" onchange={set('pickPos')}  moduleId={id} paramId="pickPos"  readLive={live('pickPos')} />
            <NeonFader value={stiffness} min={0}  max={1}  defaultValue={defaultFor('stiffness')} label="Stf"          curve="linear" onchange={set('stiffness')} moduleId={id} paramId="stiffness" readLive={live('stiffness')} />
          </div>
        </div>
        <div class="group g-pick">
          <header>PICK</header>
          <div class="fader-row">
            <NeonFader value={pickTone}  min={0}   max={1} defaultValue={defaultFor('pickTone')}  label="Tone"  curve="linear" onchange={set('pickTone')}  moduleId={id} paramId="pickTone"  readLive={live('pickTone')} />
            <NeonFader value={pickGrain} min={0.1} max={4} defaultValue={defaultFor('pickGrain')} label="Grain" curve="log"    onchange={set('pickGrain')} moduleId={id} paramId="pickGrain" readLive={live('pickGrain')} />
            <NeonFader value={spread}    min={0}   max={1} defaultValue={defaultFor('spread')}    label="Sprd"  curve="linear" onchange={set('spread')}    moduleId={id} paramId="spread"    readLive={live('spread')} />
            <NeonFader value={body}      min={0}   max={1} defaultValue={defaultFor('body')}      label="Body"  curve="linear" onchange={set('body')}      moduleId={id} paramId="body"      readLive={live('body')} />
          </div>
        </div>
        <div class="group g-sel">
          <header>MODE</header>
          <!-- The `sixstrum-preset` control family (one member): the PRESET
               RECALL knob. Same stamp the shell's PRESET selector fires. -->
          <div class="sel-cell" data-testid={`sixstrum-preset-${id}-1`}>
            <div class="sel-readout" data-testid="sixstrum-tuning-name">{tuningName}</div>
            <NeonFader value={tuning} min={0} max={2} defaultValue={defaultFor('tuning')} label="Mode" curve="discrete" onchange={setMode} moduleId={id} paramId="tuning" readLive={live('tuning')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 2: ENVELOPE · STRUM · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group g-env">
          <header>ENVELOPE</header>
          <div class="fader-row">
            <NeonFader value={attack}   min={0.0005} max={5} defaultValue={defaultFor('attack')}   label="A"    units="s" curve="log"    onchange={set('attack')}   moduleId={id} paramId="attack"   readLive={live('attack')} />
            <NeonFader value={envDecay} min={0.001}  max={5} defaultValue={defaultFor('envDecay')} label="D"    units="s" curve="log"    onchange={set('envDecay')} moduleId={id} paramId="envDecay" readLive={live('envDecay')} />
            <NeonFader value={sustain}  min={0}      max={1} defaultValue={defaultFor('sustain')}  label="S"              curve="linear" onchange={set('sustain')}  moduleId={id} paramId="sustain"  readLive={live('sustain')} />
            <NeonFader value={release}  min={0.001}  max={5} defaultValue={defaultFor('release')}  label="R"    units="s" curve="log"    onchange={set('release')}  moduleId={id} paramId="release"  readLive={live('release')} />
            <NeonFader value={muteDepth} min={0}     max={1} defaultValue={defaultFor('muteDepth')} label="Mute"          curve="linear" onchange={set('muteDepth')} moduleId={id} paramId="muteDepth" readLive={live('muteDepth')} />
          </div>
        </div>
        <div class="group g-strum">
          <header>STRUM</header>
          <div class="fader-row">
            <NeonFader value={strumSpread} min={0} max={1} defaultValue={defaultFor('strumSpread')} label="Roll" curve="linear" onchange={set('strumSpread')} moduleId={id} paramId="strumSpread" readLive={live('strumSpread')} />
            <div class="sel-cell">
              <div class="sel-readout" data-testid="sixstrum-dir-name">{dirName}</div>
              <NeonFader value={strumDir} min={0} max={2} defaultValue={defaultFor('strumDir')} label="Dir" curve="discrete" onchange={set('strumDir')} moduleId={id} paramId="strumDir" readLive={live('strumDir')} />
            </div>
            <div class="sel-cell">
              <div class="sel-readout" data-testid="sixstrum-chord-name">{qualityName}</div>
              <NeonFader value={quality} min={0} max={7} defaultValue={defaultFor('quality')} label="Chord" curve="discrete" onchange={set('quality')} moduleId={id} paramId="quality" readLive={live('quality')} />
            </div>
            <button
              class="strum-btn"
              class:pulse={strumPulse}
              onclick={strum}
              data-testid="sixstrum-strum"
              title="Audition: strum all six strings (same as a strum #1 rising edge)"
            >⟋</button>
          </div>
        </div>
        <div class="group g-sel">
          <header>OUT</header>
          <div class="fader-row">
            <NeonFader value={level} min={-24} max={12} defaultValue={defaultFor('level')} label="Lvl" units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .sixstrum-card { width: 720px; }
  .sixstrum-card .band {
    padding: 5px 12px 6px;
    border-top: 1px solid #1d1f25;
  }
  .sixstrum-card .band:first-of-type { border-top: none; }
  .sixstrum-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .sixstrum-card .group {
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  /* width-weighted so groups fill the row proportionally to their content */
  .sixstrum-card .g-strings { flex: 5.2; }
  .sixstrum-card .g-pick    { flex: 4.2; }
  .sixstrum-card .g-env     { flex: 5.2; }
  .sixstrum-card .g-strum   { flex: 4.4; }
  .sixstrum-card .g-sel     { flex: 1.3; }
  .sixstrum-card .group:last-child { border-right: none; padding-right: 0; }
  .sixstrum-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #7fd4a8;
    text-transform: uppercase;
    margin: 3px 0 3px;
    opacity: 0.9;
  }
  .sixstrum-card .fader-row {
    display: flex;
    gap: 8px;
    padding: 0 2px;
    margin-bottom: 4px;
    align-items: flex-end;
    justify-content: flex-start;
  }
  .sixstrum-card .sel-cell { display: flex; flex-direction: column; align-items: center; }
  .sixstrum-card .sel-readout {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem;
    letter-spacing: 0.5px;
    color: #7fd4a8;
    text-transform: uppercase;
    margin-bottom: 2px;
    min-height: 0.75rem;
    white-space: nowrap;
  }
  .sixstrum-card .strum-btn {
    align-self: flex-end;
    font-size: 0.85rem;
    padding: 8px 12px;
    margin: 0 0 4px 2px;
    background: #14151a;
    color: #7fd4a8;
    border: 1px solid #2a2d36;
    border-radius: 4px;
    cursor: pointer;
    line-height: 1;
  }
  .sixstrum-card .strum-btn:active,
  .sixstrum-card .strum-btn.pulse {
    color: #0e1013;
    background: #7fd4a8;
    border-color: #7fd4a8;
  }
</style>
