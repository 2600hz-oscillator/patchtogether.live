<script lang="ts">
  // TidyVcoCard — flagship VA subtractive voice card. Two fader bands,
  // Ports-family chrome:
  //
  //   ┌────────── OSC ───────────────────────┬───── FILTER ────────────┐
  //   │ Shp1 Shp2 PW Det Oct2 Mix Sub        │ Cut Res Drv Env Trk     │
  //   ├───── FILTER EG ──────┬─── AMP EG ────┼──── OUT ────────────────┤
  //   │ F.A F.D F.S F.R      │ A D S R       │ Wdth Lvl [HOLD]         │
  //   └──────────────────────┴───────────────┴─────────────────────────┘
  //
  // The HOLD pad is press-to-drone (the clap-pad press-param pattern):
  // pointerdown writes 1 to the `hold` param + setParam-pushes it to the
  // engine; pointerup writes 0. The worklet ORs the pad with the mono gate
  // input, so holding it opens the amp/filter EGs like a held note.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ScopeScreen from '$lib/ui/controls/ScopeScreen.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { tidyVcoDef } from '$lib/audio/modules/tidy-vco';
  import type { ModuleNode } from '$lib/graph/types';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const { defaultFor, paramVal, set, live } = cardParams(tidyVcoDef, () => id, () => node);

  // Per-param reactive reads.
  let shape1 = $derived(paramVal('shape1'));
  let shape2 = $derived(paramVal('shape2'));
  let pw = $derived(paramVal('pw'));
  let detune = $derived(paramVal('detune'));
  let oct2 = $derived(paramVal('oct2'));
  let mix = $derived(paramVal('mix'));
  let sub = $derived(paramVal('sub'));
  let fold = $derived(paramVal('fold'));
  let sym = $derived(paramVal('sym'));
  let cutoff = $derived(paramVal('cutoff'));
  let res = $derived(paramVal('res'));
  let drive = $derived(paramVal('drive'));
  let env = $derived(paramVal('env'));
  let track = $derived(paramVal('track'));
  let fatk = $derived(paramVal('fatk'));
  let fdec = $derived(paramVal('fdec'));
  let fsus = $derived(paramVal('fsus'));
  let frel = $derived(paramVal('frel'));
  let atk = $derived(paramVal('atk'));
  let dec = $derived(paramVal('dec'));
  let sus = $derived(paramVal('sus'));
  let rel = $derived(paramVal('rel'));
  let width = $derived(paramVal('width'));
  let level = $derived(paramVal('level'));

  let holding = $derived((node?.params?.['hold'] ?? 0) >= 0.5);

  /** Press/release the HOLD pad — write the param (peers + store see the
   *  held state) AND push straight to the engine for immediate gating. */
  function setHold(v: 0 | 1): void {
    setNodeParam(id, 'hold', v);
    const e = engineCtx.get();
    if (e && node) e.setParam(node, 'hold', v);
  }
  function onHoldDown(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic event — fine */
    }
    setHold(1);
  }
  function onHoldUp(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      /* not captured — fine */
    }
    setHold(0);
  }

  // Rear PatchPanel jacks grouped into labeled SECTIONS that mirror the
  // on-card headers (OSC · WAVEFOLD · DIODE FILTER · FILTER EG · AMP EG · OUT):
  // each section lists its per-control CV jacks in KNOB ORDER. The structural
  // poly/pitch/gate jacks + the stereo audio outputs sit in a trailing
  // POLY/OUT section.
  const sections: { label: string; inputs?: PortDescriptor[]; outputs?: PortDescriptor[] }[] = [
    {
      label: 'OSC',
      inputs: [
        { id: 'shape1_cv', label: 'SHP1', cable: 'cv' },
        { id: 'shape2_cv', label: 'SHP2', cable: 'cv' },
        { id: 'pwm_cv',    label: 'PWM',  cable: 'cv' },
        { id: 'detune_cv', label: 'DET',  cable: 'cv' },
        { id: 'oct2_cv',   label: 'OCT2', cable: 'cv' },
        { id: 'mix_cv',    label: 'MIX',  cable: 'cv' },
        { id: 'sub_cv',    label: 'SUB',  cable: 'cv' },
      ],
    },
    {
      label: 'WAVEFOLD',
      inputs: [
        { id: 'fold_cv', label: 'FOLD', cable: 'cv' },
        { id: 'sym_cv',  label: 'SYM',  cable: 'cv' },
      ],
    },
    {
      label: 'DIODE FILTER',
      inputs: [
        { id: 'cutoff_cv', label: 'CUT', cable: 'cv' },
        { id: 'res_cv',    label: 'RES', cable: 'cv' },
        { id: 'drive_cv',  label: 'DRV', cable: 'cv' },
        { id: 'env_cv',    label: 'ENV', cable: 'cv' },
        { id: 'track_cv',  label: 'TRK', cable: 'cv' },
      ],
    },
    {
      label: 'FILTER EG',
      inputs: [
        { id: 'fatk_cv', label: 'F.A', cable: 'cv' },
        { id: 'fdec_cv', label: 'F.D', cable: 'cv' },
        { id: 'fsus_cv', label: 'F.S', cable: 'cv' },
        { id: 'frel_cv', label: 'F.R', cable: 'cv' },
      ],
    },
    {
      label: 'AMP EG',
      inputs: [
        { id: 'atk_cv', label: 'A', cable: 'cv' },
        { id: 'dec_cv', label: 'D', cable: 'cv' },
        { id: 'sus_cv', label: 'S', cable: 'cv' },
        { id: 'rel_cv', label: 'R', cable: 'cv' },
      ],
    },
    {
      label: 'OUT',
      inputs: [
        { id: 'width_cv', label: 'WDTH', cable: 'cv' },
        { id: 'level_cv', label: 'LVL',  cable: 'cv' },
      ],
    },
    {
      label: 'POLY/OUT',
      inputs: [
        { id: 'poly',  label: 'POLY',  cable: 'polyPitchGate' },
        { id: 'pitch', label: 'PITCH', cable: 'cv' },
        { id: 'gate',  label: 'GATE',  cable: 'gate' },
      ],
      outputs: [
        { id: 'out_l', label: 'OUT L', cable: 'audio' },
        { id: 'out_r', label: 'OUT R', cable: 'audio' },
      ],
    },
  ];
</script>

<div class="mod-card tidyvco-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="TIDY VCO" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={540}>
    <section class="band">
      <div class="groups">
        <div class="group osc">
          <header>OSC</header>
          <!-- WAVE-screen glyph: OSC1's live saw↔pulse shape morph (shape1). -->
          <div class="wave-screen">
            <ScopeScreen
              mode="wave"
              morph={shape1}
              pw={pw}
              width={132}
              height={40}
              testid="tidyvco-wave-screen"
              ariaLabel="OSC1 wave shape"
            />
          </div>
          <div class="fader-row">
            <Fader value={shape1} min={0} max={1} defaultValue={defaultFor('shape1')} label="Shp1" curve="linear" onchange={set('shape1')} moduleId={id} paramId="shape1" readLive={live('shape1')} />
            <Fader value={shape2} min={0} max={1} defaultValue={defaultFor('shape2')} label="Shp2" curve="linear" onchange={set('shape2')} moduleId={id} paramId="shape2" readLive={live('shape2')} />
            <Fader value={pw} min={0.05} max={0.5} defaultValue={defaultFor('pw')} label="PW" curve="linear" onchange={set('pw')} moduleId={id} paramId="pw" readLive={live('pw')} />
            <Fader value={detune} min={-50} max={50} defaultValue={defaultFor('detune')} label="Det" units="¢" curve="linear" onchange={set('detune')} moduleId={id} paramId="detune" readLive={live('detune')} />
            <Fader value={oct2} min={-1} max={1} defaultValue={defaultFor('oct2')} label="Oct2" curve="discrete" onchange={set('oct2')} moduleId={id} paramId="oct2" readLive={live('oct2')} />
            <Fader value={mix} min={0} max={1} defaultValue={defaultFor('mix')} label="Mix" curve="linear" onchange={set('mix')} moduleId={id} paramId="mix" readLive={live('mix')} />
            <Fader value={sub} min={0} max={1} defaultValue={defaultFor('sub')} label="Sub" curve="linear" onchange={set('sub')} moduleId={id} paramId="sub" readLive={live('sub')} />
          </div>
        </div>
        <div class="group fold">
          <header>WAVEFOLD</header>
          <div class="fader-row">
            <Fader value={fold} min={0} max={1} defaultValue={defaultFor('fold')} label="Fold" curve="linear" onchange={set('fold')} moduleId={id} paramId="fold" readLive={live('fold')} />
            <Fader value={sym} min={-1} max={1} defaultValue={defaultFor('sym')} label="Sym" curve="linear" onchange={set('sym')} moduleId={id} paramId="sym" readLive={live('sym')} />
          </div>
        </div>
        <div class="group">
          <header>DIODE FILTER</header>
          <div class="fader-row">
            <Fader value={cutoff} min={40} max={14000} defaultValue={defaultFor('cutoff')} label="Cut" units="Hz" curve="log" onchange={set('cutoff')} moduleId={id} paramId="cutoff" readLive={live('cutoff')} />
            <Fader value={res} min={0} max={1} defaultValue={defaultFor('res')} label="Res" curve="linear" onchange={set('res')} moduleId={id} paramId="res" readLive={live('res')} />
            <Fader value={drive} min={0} max={1} defaultValue={defaultFor('drive')} label="Drv" curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <Fader value={env} min={-1} max={1} defaultValue={defaultFor('env')} label="Env" curve="linear" onchange={set('env')} moduleId={id} paramId="env" readLive={live('env')} />
            <Fader value={track} min={0} max={1} defaultValue={defaultFor('track')} label="Trk" curve="linear" onchange={set('track')} moduleId={id} paramId="track" readLive={live('track')} />
          </div>
        </div>
      </div>
    </section>

    <section class="band">
      <div class="groups">
        <div class="group">
          <header>FILTER EG</header>
          <div class="fader-row">
            <Fader value={fatk} min={0.0005} max={5} defaultValue={defaultFor('fatk')} label="A" units="s" curve="log" onchange={set('fatk')} moduleId={id} paramId="fatk" readLive={live('fatk')} />
            <Fader value={fdec} min={0.001} max={5} defaultValue={defaultFor('fdec')} label="D" units="s" curve="log" onchange={set('fdec')} moduleId={id} paramId="fdec" readLive={live('fdec')} />
            <Fader value={fsus} min={0} max={1} defaultValue={defaultFor('fsus')} label="S" curve="linear" onchange={set('fsus')} moduleId={id} paramId="fsus" readLive={live('fsus')} />
            <Fader value={frel} min={0.001} max={5} defaultValue={defaultFor('frel')} label="R" units="s" curve="log" onchange={set('frel')} moduleId={id} paramId="frel" readLive={live('frel')} />
          </div>
        </div>
        <div class="group">
          <header>AMP EG</header>
          <div class="fader-row">
            <Fader value={atk} min={0.0005} max={5} defaultValue={defaultFor('atk')} label="A" units="s" curve="log" onchange={set('atk')} moduleId={id} paramId="atk" readLive={live('atk')} />
            <Fader value={dec} min={0.001} max={5} defaultValue={defaultFor('dec')} label="D" units="s" curve="log" onchange={set('dec')} moduleId={id} paramId="dec" readLive={live('dec')} />
            <Fader value={sus} min={0} max={1} defaultValue={defaultFor('sus')} label="S" curve="linear" onchange={set('sus')} moduleId={id} paramId="sus" readLive={live('sus')} />
            <Fader value={rel} min={0.001} max={5} defaultValue={defaultFor('rel')} label="R" units="s" curve="log" onchange={set('rel')} moduleId={id} paramId="rel" readLive={live('rel')} />
          </div>
        </div>
        <div class="group out">
          <header>OUT</header>
          <div class="fader-row">
            <Fader value={width} min={0} max={1} defaultValue={defaultFor('width')} label="Wdth" curve="linear" onchange={set('width')} moduleId={id} paramId="width" readLive={live('width')} />
            <Fader value={level} min={-24} max={12} defaultValue={defaultFor('level')} label="Lvl" units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
            <button
              class="hold-pad"
              class:held={holding}
              onpointerdown={onHoldDown}
              onpointerup={onHoldUp}
              onpointercancel={onHoldUp}
              data-testid="tidyvco-hold"
              title="HOLD: gate the voice while pressed (drone/audition)"
            >HOLD</button>
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .tidyvco-card {
    width: 720px; /* the 4 hp slot (4 × 180px) — matches the declared def hp */
    min-height: 200px;
  }
  .tidyvco-card .band {
    padding: 6px 12px 2px;
  }
  .tidyvco-card .band + .band {
    border-top: 1px solid #1d1f25;
  }
  .tidyvco-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .tidyvco-card .group {
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .tidyvco-card .group.osc {
    flex: 1.4;
  }
  .tidyvco-card .group.fold {
    flex: 0.6; /* just 2 faders (Fold + Sym) — keep it compact */
  }
  .tidyvco-card .group {
    flex: 1;
  }
  .tidyvco-card .group:last-child {
    border-right: none;
    padding-right: 0;
  }
  .tidyvco-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #6fd3a6;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .tidyvco-card .fader-row {
    display: flex;
    gap: 8px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .tidyvco-card .wave-screen {
    margin: 2px 0 6px;
  }
  .tidyvco-card .hold-pad {
    align-self: center;
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.8px;
    padding: 14px 10px;
    background: #14151a;
    color: #9aa0ae;
    border: 1px solid #2a2d36;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    touch-action: none; /* keep pointerdown gestures from being eaten by scroll */
  }
  .tidyvco-card .hold-pad.held {
    color: #6fd3a6;
    border-color: #6fd3a6;
    background: #101c16;
  }
</style>
