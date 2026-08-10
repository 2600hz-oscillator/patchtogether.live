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

  // ⚠ EVERY RANGE, CURVE AND UNIT IS BOUND TO THE DEF (`paramSpec`), NEVER
  // RE-TYPED. This card used to restate 34 literal `min=`/`max=`/`defaultValue=`
  // props — the most of any card in its batch — over a def that already
  // declares all of them, and nothing could see the disagreement: contract-lock,
  // module-docs-lint and every range assertion read the DEF. The backdraft bug
  // (a pad writing ±1 against a def declaring ±0.2) is exactly this shape, and
  // the guard that exists for it is opt-in, so this card is now enrolled in
  // RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS in card-range-source.test.ts.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    cofefveDelayDef,
    COFEFVE_TEMPO_SYNC_OPTIONS,
    COFEFVE_CLOCK_SOURCE_OPTIONS,
    COFEFVE_PAN_MODE_OPTIONS,
    COFEFVE_FILTER_MODE_OPTIONS,
  } from '$lib/audio/modules/cofefve';
  import type { ModuleNode } from '$lib/graph/types';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(cofefveDelayDef, () => id, () => node);

  /** THE ONE COPY of every number this card paints. */
  const P = {
    delayTime:       paramSpec(cofefveDelayDef, 'delayTime'),
    lfoAmount:       paramSpec(cofefveDelayDef, 'lfoAmount'),
    lfoFrequency:    paramSpec(cofefveDelayDef, 'lfoFrequency'),
    driftAmount:     paramSpec(cofefveDelayDef, 'driftAmount'),
    driftSpeed:      paramSpec(cofefveDelayDef, 'driftSpeed'),
    feedback:        paramSpec(cofefveDelayDef, 'feedback'),
    stereoOffset:    paramSpec(cofefveDelayDef, 'stereoOffset'),
    pan:             paramSpec(cofefveDelayDef, 'pan'),
    duckAmount:      paramSpec(cofefveDelayDef, 'duckAmount'),
    duckAttack:      paramSpec(cofefveDelayDef, 'duckAttack'),
    duckRelease:     paramSpec(cofefveDelayDef, 'duckRelease'),
    lowCut:          paramSpec(cofefveDelayDef, 'lowCut'),
    highCut:         paramSpec(cofefveDelayDef, 'highCut'),
    driveGain:       paramSpec(cofefveDelayDef, 'driveGain'),
    driveMix:        paramSpec(cofefveDelayDef, 'driveMix'),
    driveCutoff:     paramSpec(cofefveDelayDef, 'driveCutoff'),
    driveIterations: paramSpec(cofefveDelayDef, 'driveIterations'),
    dryVolume:       paramSpec(cofefveDelayDef, 'dryVolume'),
    wetVolume:       paramSpec(cofefveDelayDef, 'wetVolume'),
  } as const;

  function setDiscrete(k: string, v: number): void {
    setNodeParam(id, k, v);
  }

  let tempoSync   = $derived(Math.round(paramVal('tempoSync')));
  let clockSource = $derived(Math.round(paramVal('clockSource')));
  let panMode     = $derived(Math.round(paramVal('panMode')));
  let filterMode  = $derived(Math.round(paramVal('filterMode')));
  let iterations  = $derived(Math.round(paramVal('driveIterations')));

  const inputs = portsFromDef(cofefveDelayDef.inputs, {
    clock: 'CLK', time_cv: 'TIME', feedback_cv: 'FBK', mix_cv: 'MIX', drive_cv: 'DRV',
    lfo_cv: 'WOW', drift_cv: 'FLTR', pan_cv: 'PAN', duck_cv: 'DUCK',
  });
  const outputs = portsFromDef(cofefveDelayDef.outputs);
</script>

<div class="mod-card cofefve-delay-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={620}>
    <div class="cofefve-body">
      <!-- LEFT RAIL -->
      <aside class="rail">
        <div class="rail-title"><ModuleTitle {id} {data} defaultLabel="COFEFVE DELAY" inline /></div>
        <div class="rail-faders">
          <Fader value={paramVal('dryVolume')} min={P.dryVolume.min} max={P.dryVolume.max} defaultValue={P.dryVolume.defaultValue} curve={P.dryVolume.curve} units={P.dryVolume.units}   label="Dry" onchange={set('dryVolume')} moduleId={id} paramId="dryVolume" readLive={live('dryVolume')} />
          <Fader value={paramVal('wetVolume')} min={P.wetVolume.min} max={P.wetVolume.max} defaultValue={P.wetVolume.defaultValue} curve={P.wetVolume.curve} units={P.wetVolume.units} label="Wet" onchange={set('wetVolume')} moduleId={id} paramId="wetVolume" readLive={live('wetVolume')} />
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
              <Knob value={paramVal('delayTime')} min={P.delayTime.min} max={P.delayTime.max} defaultValue={P.delayTime.defaultValue} curve={P.delayTime.curve} units={P.delayTime.units} label="Time" onchange={set('delayTime')} moduleId={id} paramId="delayTime" readLive={live('delayTime')} />
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
              <Knob value={paramVal('lfoAmount')} min={P.lfoAmount.min} max={P.lfoAmount.max} defaultValue={P.lfoAmount.defaultValue} curve={P.lfoAmount.curve} units={P.lfoAmount.units}     label="Amount"    onchange={set('lfoAmount')} moduleId={id} paramId="lfoAmount" readLive={live('lfoAmount')} />
              <Knob value={paramVal('lfoFrequency')} min={P.lfoFrequency.min} max={P.lfoFrequency.max} defaultValue={P.lfoFrequency.defaultValue} curve={P.lfoFrequency.curve} units={P.lfoFrequency.units} label="Frequency" onchange={set('lfoFrequency')} moduleId={id} paramId="lfoFrequency" readLive={live('lfoFrequency')} />
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-drift">
            <header>FLUTTER</header>
            <div class="knobs">
              <Knob value={paramVal('driftAmount')} min={P.driftAmount.min} max={P.driftAmount.max} defaultValue={P.driftAmount.defaultValue} curve={P.driftAmount.curve} units={P.driftAmount.units} label="Amount" onchange={set('driftAmount')} moduleId={id} paramId="driftAmount" readLive={live('driftAmount')} />
              <Knob value={paramVal('driftSpeed')} min={P.driftSpeed.min} max={P.driftSpeed.max} defaultValue={P.driftSpeed.defaultValue} curve={P.driftSpeed.curve} units={P.driftSpeed.units}      label="Speed"  onchange={set('driftSpeed')} moduleId={id} paramId="driftSpeed" readLive={live('driftSpeed')} />
            </div>
          </div>
        </section>

        <!-- TONE area: FEEDBACK / DUCKING -->
        <section class="band">
          <div class="group" data-testid="cofefve-group-feedback">
            <header>FEEDBACK</header>
            <div class="knobs">
              <Knob value={paramVal('feedback')} min={P.feedback.min} max={P.feedback.max} defaultValue={P.feedback.defaultValue} curve={P.feedback.curve} units={P.feedback.units}       label="Amount" onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
              <Knob value={paramVal('stereoOffset')} min={P.stereoOffset.min} max={P.stereoOffset.max} defaultValue={P.stereoOffset.defaultValue} curve={P.stereoOffset.curve} units={P.stereoOffset.units} label="Stereo" onchange={set('stereoOffset')} moduleId={id} paramId="stereoOffset" readLive={live('stereoOffset')} />
              <Knob value={paramVal('pan')} min={P.pan.min} max={P.pan.max} defaultValue={P.pan.defaultValue} curve={P.pan.curve} units={P.pan.units}          label="Pan" onchange={set('pan')} moduleId={id} paramId="pan" readLive={live('pan')} />
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
              <Knob value={paramVal('duckAmount')} min={P.duckAmount.min} max={P.duckAmount.max} defaultValue={P.duckAmount.defaultValue} curve={P.duckAmount.curve} units={P.duckAmount.units}      label="Amount"  onchange={set('duckAmount')} moduleId={id} paramId="duckAmount" readLive={live('duckAmount')} />
              <Knob value={paramVal('duckAttack')} min={P.duckAttack.min} max={P.duckAttack.max} defaultValue={P.duckAttack.defaultValue} curve={P.duckAttack.curve} units={P.duckAttack.units}  label="Attack"  onchange={set('duckAttack')} moduleId={id} paramId="duckAttack" readLive={live('duckAttack')} />
              <Knob value={paramVal('duckRelease')} min={P.duckRelease.min} max={P.duckRelease.max} defaultValue={P.duckRelease.defaultValue} curve={P.duckRelease.curve} units={P.duckRelease.units} label="Release" onchange={set('duckRelease')} moduleId={id} paramId="duckRelease" readLive={live('duckRelease')} />
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
              <Knob value={paramVal('lowCut')} min={P.lowCut.min} max={P.lowCut.max} defaultValue={P.lowCut.defaultValue} curve={P.lowCut.curve} units={P.lowCut.units}      label="Low cut"  onchange={set('lowCut')} moduleId={id} paramId="lowCut" readLive={live('lowCut')} />
              <Knob value={paramVal('highCut')} min={P.highCut.min} max={P.highCut.max} defaultValue={P.highCut.defaultValue} curve={P.highCut.curve} units={P.highCut.units} label="High cut" onchange={set('highCut')} moduleId={id} paramId="highCut" readLive={live('highCut')} />
            </div>
          </div>

          <div class="group" data-testid="cofefve-group-drive">
            <header>DRIVE</header>
            <div class="knobs">
              <Knob value={paramVal('driveGain')} min={P.driveGain.min} max={P.driveGain.max} defaultValue={P.driveGain.defaultValue} curve={P.driveGain.curve} units={P.driveGain.units}   label="Gain"   onchange={set('driveGain')} moduleId={id} paramId="driveGain" readLive={live('driveGain')} />
              <Knob value={paramVal('driveMix')} min={P.driveMix.min} max={P.driveMix.max} defaultValue={P.driveMix.defaultValue} curve={P.driveMix.curve} units={P.driveMix.units}       label="Mix"    onchange={set('driveMix')} moduleId={id} paramId="driveMix" readLive={live('driveMix')} />
              <Knob value={paramVal('driveCutoff')} min={P.driveCutoff.min} max={P.driveCutoff.max} defaultValue={P.driveCutoff.defaultValue} curve={P.driveCutoff.curve} units={P.driveCutoff.units} label="Filter" onchange={set('driveCutoff')} moduleId={id} paramId="driveCutoff" readLive={live('driveCutoff')} />
              <div class="iter-control">
                <span class="iter-label">Iterations</span>
                <!-- ⚠ A NATIVE `<input>` TAKES STRING ATTRIBUTES, so this used
                     to read `min="1" max="16"` — re-typed numbers that
                     card-range-source's `min={…}` grep is structurally unable
                     to see. Bound anyway: a gate's blind spot is not a licence,
                     and this is the module's one non-primitive control. -->
                <input
                  type="range"
                  data-testid="cofefve-drive-iters"
                  min={P.driveIterations.min}
                  max={P.driveIterations.max}
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
