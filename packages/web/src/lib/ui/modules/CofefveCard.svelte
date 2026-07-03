<script lang="ts">
  // CofefveCard — the COFEFVE DELAY faceplate (own-code analog BBD/tape delay,
  // the clean-room replacement for the retired Cocoa Delay card). Layout:
  //
  //   ┌ left rail ┐ ┌──────── TIME band ─────────────────────────┐
  //   │  COFEFVE  │ │ DELAY        WOW          FLUTTER           │
  //   │  DELAY    │ │ Time Sync    Amt Freq     Amt Speed         │
  //   │  Dry      │ ├──────────── TONE area ─────────────────────┤
  //   │  Wet      │ │ FEEDBACK              DUCKING               │
  //   │  v1.0     │ │ Amt Stereo Pan PanMode  Amt Attack Release  │
  //   └───────────┘ │ FILTER                DRIVE                 │
  //                 │ Mode Locut Hicut   Gain Mix Filt Iters      │
  //                 └────────────────────────────────────────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    cofefveDelayDef,
    COFEFVE_TEMPO_SYNC_OPTIONS,
    COFEFVE_CLOCK_SOURCE_OPTIONS,
    COFEFVE_PAN_MODE_OPTIONS,
    COFEFVE_FILTER_MODE_OPTIONS,
  } from '$lib/audio/modules/cofefve';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return cofefveDelayDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  function setDiscrete(k: string, v: number): void {
    setNodeParam(id, k, v);
  }

  let tempoSync   = $derived(Math.round(paramVal('tempoSync')));
  let clockSource = $derived(Math.round(paramVal('clockSource')));
  let panMode     = $derived(Math.round(paramVal('panMode')));
  let filterMode  = $derived(Math.round(paramVal('filterMode')));
  let iterations  = $derived(Math.round(paramVal('driveIterations')));

  const PI = Math.PI;

  const inputs: PortDescriptor[] = [
    { id: 'inL',         label: 'IN L', cable: 'audio' },
    { id: 'inR',         label: 'IN R', cable: 'audio' },
    { id: 'clock',       label: 'CLK',  cable: 'gate' },
    { id: 'time_cv',     label: 'TIME', cable: 'cv' },
    { id: 'feedback_cv', label: 'FBK',  cable: 'cv' },
    { id: 'mix_cv',      label: 'MIX',  cable: 'cv' },
    { id: 'drive_cv',    label: 'DRV',  cable: 'cv' },
    { id: 'lfo_cv',      label: 'WOW',  cable: 'cv' },
    { id: 'drift_cv',    label: 'FLTR', cable: 'cv' },
    { id: 'pan_cv',      label: 'PAN',  cable: 'cv' },
    { id: 'duck_cv',     label: 'DUCK', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'outL', label: 'OUT L', cable: 'audio' },
    { id: 'outR', label: 'OUT R', cable: 'audio' },
  ];
</script>

<div class="mod-card cofefve-delay-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={620}>
    <div class="cofefve-body">
      <!-- LEFT RAIL -->
      <aside class="rail">
        <div class="rail-title"><ModuleTitle {id} {data} defaultLabel="COFEFVE DELAY" inline /></div>
        <div class="rail-faders">
          <Fader value={paramVal('dryVolume')} min={0} max={2} defaultValue={1}   label="Dry" curve="linear" onchange={set('dryVolume')} moduleId={id} paramId="dryVolume" readLive={live('dryVolume')} />
          <Fader value={paramVal('wetVolume')} min={0} max={2} defaultValue={0.5} label="Wet" curve="linear" onchange={set('wetVolume')} moduleId={id} paramId="wetVolume" readLive={live('wetVolume')} />
        </div>
        <div class="rail-version">v1.0</div>
      </aside>

      <!-- RIGHT: controls -->
      <div class="cofefve-main">
        <!-- TIME band: DELAY / WOW / FLUTTER -->
        <section class="band time-band" data-testid="cofefve-time-band">
          <div class="group" data-testid="cofefve-group-delay">
            <header>DELAY</header>
            <div class="knobs">
              <Knob value={paramVal('delayTime')} min={0.001} max={2} defaultValue={0.2} label="Time" units="s" curve="log" onchange={set('delayTime')} moduleId={id} paramId="delayTime" readLive={live('delayTime')} />
              <label class="ddl">
                <span>Tempo sync</span>
                <select data-testid="cofefve-tempo-sync" value={tempoSync} onchange={(e) => setDiscrete('tempoSync', Number((e.currentTarget as HTMLSelectElement).value))}>
                  {#each COFEFVE_TEMPO_SYNC_OPTIONS as opt, i (i)}
                    <option value={i}>{opt}</option>
                  {/each}
                </select>
              </label>
              <!-- System = TIMELORDE bpm; MIDI = incoming MIDI clock (0xF8).
                   A patched CLK cable overrides either source. -->
              <label class="ddl">
                <span>Clk src</span>
                <select data-testid="cofefve-clock-source" value={clockSource} onchange={(e) => setDiscrete('clockSource', Number((e.currentTarget as HTMLSelectElement).value))}>
                  {#each COFEFVE_CLOCK_SOURCE_OPTIONS as opt, i (i)}
                    <option value={i}>{opt}</option>
                  {/each}
                </select>
              </label>
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-lfo">
            <header>WOW</header>
            <div class="knobs">
              <Knob value={paramVal('lfoAmount')}    min={0} max={0.5} defaultValue={0}  label="Amount"    curve="linear" onchange={set('lfoAmount')} moduleId={id} paramId="lfoAmount" readLive={live('lfoAmount')} />
              <Knob value={paramVal('lfoFrequency')} min={0.1} max={10} defaultValue={2} label="Frequency" units="hz" curve="log" onchange={set('lfoFrequency')} moduleId={id} paramId="lfoFrequency" readLive={live('lfoFrequency')} />
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-drift">
            <header>FLUTTER</header>
            <div class="knobs">
              <Knob value={paramVal('driftAmount')} min={0} max={0.05} defaultValue={0.001} label="Amount" curve="linear" onchange={set('driftAmount')} moduleId={id} paramId="driftAmount" readLive={live('driftAmount')} />
              <Knob value={paramVal('driftSpeed')}  min={0.1} max={10} defaultValue={1}     label="Speed"  curve="log" onchange={set('driftSpeed')} moduleId={id} paramId="driftSpeed" readLive={live('driftSpeed')} />
            </div>
          </div>
        </section>

        <!-- TONE area: FEEDBACK / DUCKING -->
        <section class="band">
          <div class="group" data-testid="cofefve-group-feedback">
            <header>FEEDBACK</header>
            <div class="knobs">
              <Knob value={paramVal('feedback')}     min={-1} max={1}   defaultValue={0.5} label="Amount" curve="linear" onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
              <Knob value={paramVal('stereoOffset')} min={-0.5} max={0.5} defaultValue={0} label="Stereo" curve="linear" onchange={set('stereoOffset')} moduleId={id} paramId="stereoOffset" readLive={live('stereoOffset')} />
              <Knob value={paramVal('pan')}          min={-PI * 0.5} max={PI * 0.5} defaultValue={0} label="Pan" curve="linear" onchange={set('pan')} moduleId={id} paramId="pan" readLive={live('pan')} />
              <label class="ddl">
                <span>Pan mode</span>
                <select data-testid="cofefve-pan-mode" value={panMode} onchange={(e) => setDiscrete('panMode', Number((e.currentTarget as HTMLSelectElement).value))}>
                  {#each COFEFVE_PAN_MODE_OPTIONS as opt, i (i)}
                    <option value={i}>{opt}</option>
                  {/each}
                </select>
              </label>
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-ducking">
            <header>DUCKING</header>
            <div class="knobs">
              <Knob value={paramVal('duckAmount')}  min={0} max={10}  defaultValue={0}    label="Amount"  curve="linear" onchange={set('duckAmount')} moduleId={id} paramId="duckAmount" readLive={live('duckAmount')} />
              <Knob value={paramVal('duckAttack')}  min={0.1} max={100} defaultValue={10} label="Attack"  curve="log" onchange={set('duckAttack')} moduleId={id} paramId="duckAttack" readLive={live('duckAttack')} />
              <Knob value={paramVal('duckRelease')} min={0.1} max={100} defaultValue={10} label="Release" curve="log" onchange={set('duckRelease')} moduleId={id} paramId="duckRelease" readLive={live('duckRelease')} />
            </div>
          </div>
        </section>

        <!-- FILTER / DRIVE -->
        <section class="band">
          <div class="group" data-testid="cofefve-group-filter">
            <header>FILTER</header>
            <div class="knobs">
              <label class="ddl">
                <span>Mode</span>
                <select data-testid="cofefve-filter-mode" value={filterMode} onchange={(e) => setDiscrete('filterMode', Number((e.currentTarget as HTMLSelectElement).value))}>
                  {#each COFEFVE_FILTER_MODE_OPTIONS as opt, i (i)}
                    <option value={i}>{opt}</option>
                  {/each}
                </select>
              </label>
              <Knob value={paramVal('lowCut')}  min={0.01} max={1}    defaultValue={0.75}  label="Low cut"  curve="linear" onchange={set('lowCut')} moduleId={id} paramId="lowCut" readLive={live('lowCut')} />
              <Knob value={paramVal('highCut')} min={0.001} max={0.99} defaultValue={0.001} label="High cut" curve="linear" onchange={set('highCut')} moduleId={id} paramId="highCut" readLive={live('highCut')} />
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-drive">
            <header>DRIVE</header>
            <div class="knobs">
              <Knob value={paramVal('driveGain')}   min={0} max={10} defaultValue={0.1} label="Gain"   curve="linear" onchange={set('driveGain')} moduleId={id} paramId="driveGain" readLive={live('driveGain')} />
              <Knob value={paramVal('driveMix')}    min={0} max={1}  defaultValue={1}   label="Mix"    curve="linear" onchange={set('driveMix')} moduleId={id} paramId="driveMix" readLive={live('driveMix')} />
              <Knob value={paramVal('driveCutoff')} min={0.01} max={1} defaultValue={1} label="Filter" curve="linear" onchange={set('driveCutoff')} moduleId={id} paramId="driveCutoff" readLive={live('driveCutoff')} />
              <div class="iter-control">
                <span class="iter-label">Iterations</span>
                <input
                  type="range"
                  data-testid="cofefve-drive-iters"
                  min="1"
                  max="16"
                  step="1"
                  value={iterations}
                  oninput={(e) => setDiscrete('driveIterations', Number((e.currentTarget as HTMLInputElement).value))}
                />
                <span class="iter-readout">{iterations}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .cofefve-delay-card {
    width: 620px;
    background: var(--cofefve-bg, #0f1a18);
    color: #e2ecea;
  }
  .cofefve-body {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 8px;
    padding: 8px;
  }
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    background: linear-gradient(180deg, #1f6b57 0%, #142a24 100%);
    border-radius: 5px;
    padding: 10px 6px;
  }
  .rail-title {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-family: var(--font-display, inherit);
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: 0.12em;
    color: #fff;
    flex: 0 0 auto;
    margin-bottom: 4px;
  }
  .rail-faders {
    display: flex;
    gap: 8px;
    flex: 1 1 auto;
  }
  .rail-version {
    font-family: var(--font-mono, monospace);
    font-size: 0.55rem;
    color: rgba(255, 255, 255, 0.4);
  }
  .cofefve-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .band {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .time-band {
    background: linear-gradient(180deg, rgba(31, 107, 87, 0.55) 0%, rgba(20, 42, 36, 0.0) 100%);
    border-radius: 5px;
    padding: 4px 6px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group header {
    font-family: var(--font-display, inherit);
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.06em;
    color: #e7f3ef;
    text-align: center;
  }
  .knobs {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    justify-content: center;
  }
  .ddl {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 0.55rem;
    letter-spacing: 0.04em;
    color: var(--text-muted, #a8c7bd);
  }
  .ddl select {
    background: #142a24;
    color: #e2ecea;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 3px;
    font-size: 0.62rem;
    padding: 2px 4px;
    font-family: var(--font-mono, monospace);
  }
  .iter-control {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 0.55rem;
    color: var(--text-muted, #a8c7bd);
  }
  .iter-control input[type='range'] {
    width: 56px;
  }
  .iter-readout {
    font-family: var(--font-mono, monospace);
    color: #e2ecea;
    font-size: 0.7rem;
  }
</style>
