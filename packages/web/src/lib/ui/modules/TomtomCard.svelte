<script lang="ts">
  // TomtomCard — analog-modeled tom-tom voice card. Compact single-band
  // layout (curated 7-knob voice + level), Ports-family chrome:
  //
  //   ┌───── MEMBRANE ──────────┬──── COLOR ─────┬──── OUT ──────┐
  //   │ Tune Bend BTim Decay    │ Tone Nse Drv   │ Lvl [STRIKE]  │
  //   └─────────────────────────┴────────────────┴───────────────┘
  //
  // The STRIKE pad is press-to-fire (the bluebox press-param pattern):
  // pointerdown writes 1 to the `strike` param + setParam-pushes it to the
  // engine for low-latency response; pointerup writes 0. The worklet ORs
  // the pad with trigger_in, so its rising edge fires exactly ONE hit.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { tomtomDef } from '$lib/audio/modules/tomtom';
  import type { ModuleNode } from '$lib/graph/types';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const { defaultFor, paramVal, set, live } = cardParams(tomtomDef, () => id, () => node);

  // Per-param reactive reads.
  let tune     = $derived(paramVal('tune'));
  let bendAmt  = $derived(paramVal('bend_amt'));
  let bendTime = $derived(paramVal('bend_time'));
  let decay    = $derived(paramVal('decay'));
  let tone     = $derived(paramVal('tone'));
  let noise    = $derived(paramVal('noise'));
  let drive    = $derived(paramVal('drive'));
  let level    = $derived(paramVal('level'));

  let striking = $derived((node?.params?.['strike'] ?? 0) >= 0.5);

  /** Press/release the STRIKE pad — write the param (peers + store see the
   *  held state) AND push straight to the engine for immediate strike. */
  function setStrike(v: 0 | 1): void {
    setNodeParam(id, 'strike', v);
    const e = engineCtx.get();
    if (e && node) e.setParam(node, 'strike', v);
  }
  function onStrikeDown(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch { /* synthetic event — fine */ }
    setStrike(1);
  }
  function onStrikeUp(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch { /* not captured — fine */ }
    setStrike(0);
  }

  // Rear PatchPanel jacks grouped into labeled SECTIONS that mirror the
  // on-card headers (MEMBRANE · COLOR · OUT): each section lists its
  // per-control CV jacks in KNOB ORDER. The structural strike/accent/pitch
  // jacks + the audio output sit in a trailing TRIG/OUT section.
  const sections: { label: string; inputs?: PortDescriptor[]; outputs?: PortDescriptor[] }[] = [
    {
      label: 'MEMBRANE',
      inputs: [
        { id: 'tune_cv',      label: 'TUNE', cable: 'cv' },
        { id: 'bend_cv',      label: 'BEND', cable: 'cv' },
        { id: 'bend_time_cv', label: 'BTIM', cable: 'cv' },
        { id: 'decay_cv',     label: 'DEC',  cable: 'cv' },
      ],
    },
    {
      label: 'COLOR',
      inputs: [
        { id: 'tone_cv',  label: 'TONE', cable: 'cv' },
        { id: 'noise_cv', label: 'NSE',  cable: 'cv' },
        { id: 'drive_cv', label: 'DRV',  cable: 'cv' },
      ],
    },
    {
      label: 'OUT',
      inputs: [{ id: 'level_cv', label: 'LVL', cable: 'cv' }],
    },
    {
      label: 'TRIG/OUT',
      inputs: [
        { id: 'trigger_in', label: 'TRIG',  cable: 'gate' },
        { id: 'accent_in',  label: 'ACC',   cable: 'cv' },
        { id: 'pitch_cv',   label: 'V/OCT', cable: 'cv' },
      ],
      outputs: [{ id: 'audio_out', label: 'OUT', cable: 'audio' }],
    },
  ];
</script>

<div class="mod-card tomtom-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="TOM DRUM" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={440}>
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>MEMBRANE</header>
          <div class="fader-row">
            <Fader value={tune}     min={60} max={400}  defaultValue={defaultFor('tune')}      label="Tune" units="Hz" curve="log"    onchange={set('tune')}      moduleId={id} paramId="tune"      readLive={live('tune')} />
            <Fader value={bendAmt}  min={0}  max={24}   defaultValue={defaultFor('bend_amt')}  label="Bend" units="st" curve="linear" onchange={set('bend_amt')}  moduleId={id} paramId="bend_amt"  readLive={live('bend_amt')} />
            <Fader value={bendTime} min={10} max={300}  defaultValue={defaultFor('bend_time')} label="BTim" units="ms" curve="log"    onchange={set('bend_time')} moduleId={id} paramId="bend_time" readLive={live('bend_time')} />
            <Fader value={decay}    min={40} max={1500} defaultValue={defaultFor('decay')}     label="Dec"  units="ms" curve="log"    onchange={set('decay')}     moduleId={id} paramId="decay"     readLive={live('decay')} />
          </div>
        </div>
        <div class="group">
          <header>COLOR</header>
          <div class="fader-row">
            <Fader value={tone}  min={0} max={1} defaultValue={defaultFor('tone')}  label="Tone" curve="linear" onchange={set('tone')}  moduleId={id} paramId="tone"  readLive={live('tone')} />
            <Fader value={noise} min={0} max={1} defaultValue={defaultFor('noise')} label="Nse"  curve="linear" onchange={set('noise')} moduleId={id} paramId="noise" readLive={live('noise')} />
            <Fader value={drive} min={0} max={1} defaultValue={defaultFor('drive')} label="Drv"  curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
          </div>
        </div>
        <div class="group">
          <header>OUT</header>
          <div class="fader-row">
            <Fader value={level} min={-24} max={12} defaultValue={defaultFor('level')} label="Lvl" units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
            <button
              class="strike"
              class:held={striking}
              onpointerdown={onStrikeDown}
              onpointerup={onStrikeUp}
              onpointercancel={onStrikeUp}
              data-testid="tomtom-strike"
              title="STRIKE: fire one hit (press edge = the strike)"
            >STRIKE</button>
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .tomtom-card { width: 460px; min-height: 200px; }
  .tomtom-card .band { padding: 6px 12px 8px; }
  .tomtom-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .tomtom-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .tomtom-card .group.wide { flex: 1.7; }
  .tomtom-card .group:last-child { border-right: none; padding-right: 0; }
  .tomtom-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #ff8f3f;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .tomtom-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .tomtom-card .strike {
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
  .tomtom-card .strike.held {
    color: #ff8f3f;
    border-color: #ff8f3f;
    background: #1c1610;
  }
</style>
