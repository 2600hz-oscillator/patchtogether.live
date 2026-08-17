<script lang="ts">
  // CloudseedCard — port of Ghost Note Audio CloudSeed reverb UI.
  //
  // Layout faithfully mirrors the reference plugin:
  //   ┌ TAPS ┐ ┌ DIFFUSION ┐ ┌ LATE REFLECTIONS ┐ ┌ EQUALISATION ┐
  //   │      │ │           │ │                  │ │              │
  //   └──────┘ └───────────┘ └──────────────────┘ └──────────────┘
  //   ┌──────────────────────────────────────────────────────────┐
  //   │  DRY  EARLY  LATE   │   IN MIX  HI CUT  LO CUT  X-SEED   │
  //   └──────────────────────────────────────────────────────────┘
  //   ┌ PRESET FOOTER (slot numbers + arrows + name + DECAY) ────┐
  //
  // Each panel toggles its primary block on/off via the small ON/OFF
  // button (matching the GhostNote pill toggle). The footer click-cycles
  // through the bundled preset bank; click the slot numbers to jump to
  // that preset; the DECAY readout reflects the live LateLineDecay value
  // (RT60 seconds) computed via cloudseed.ts's formatParameter().

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    cloudseedDef,
    CLOUDSEED_PRESETS,
    formatParameter,
    CloudseedParam,
  } from '$lib/audio/modules/cloudseed';
  import {
    applyCloudseedPreset,
    clearCloudseedTail,
  } from '$lib/ui/modules/cloudseed-preset-actions';
  import { flushShellParamWrites } from '$lib/ui/workflow/shell-param-writes';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live, engineCtx } = cardParams(cloudseedDef, () => id, () => node);

  // RANGE / DEFAULT / CURVE come from the DEF — never re-typed here.
  //
  // ⚠ THIS CARD USED TO HAND-TYPE 29 OF THEM (`min={0} max={1}
  // defaultValue={0.63} curve="linear"` ×29). They all AGREED with the def, so
  // nothing was broken — but that is the whole shape of the backdraft class:
  // contract-lock, module-docs-lint and every range assertion read only the
  // DEF, so ONE `defaultValue` edit on the def side and the card silently
  // disagrees with no gate able to see it. The PR that landed the face deleted
  // the 45-case `cppIdToParamId` switch citing exactly this reasoning and left
  // these 29 in the same file.
  const P = (pid: string): ParamDef => {
    const p = cloudseedDef.params.find((q) => q.id === pid);
    if (!p) throw new Error(`CloudseedCard: no ParamDef '${pid}' on cloudseedDef`);
    return p;
  };
  const pmin = (pid: string): number => P(pid).min;
  const pmax = (pid: string): number => P(pid).max;
  const pdef = (pid: string): number => P(pid).defaultValue;
  const pcurve = (pid: string): ParamDef['curve'] => P(pid).curve;

  function toggle(k: string): void {
    setNodeParam(id, k, paramVal(k) >= 0.5 ? 0 : 1);
  }

  // Preset footer plumbing. The recall itself lives in
  // `cloudseed-preset-actions` so THIS card and the curated face's PRESET cell
  // run the identical stamp — the card used to carry its own 45-case cppId
  // switch, and the shell's `preset_index` write used to push the preset into
  // the worklet WITHOUT touching the store (the sound changed, the saved rack
  // did not). The preset_index param is the one piece of multiplayer state
  // that drives the footer's selected-slot rendering.
  let presetIndex = $derived(Math.round(paramVal('preset_index')) | 0);
  function applyPreset(slot: number): void {
    // ⚠ DRAIN THE DOCK'S STORM GUARD FIRST — the ONE ordering hazard of having
    // two surfaces on one macro param. The face's PRESET cell commits through
    // `createSettleCommit` (an 80 ms quiet window); this footer commits
    // IMMEDIATELY. Pick a slot in the dock and then a different one here inside
    // that window and the guard's timer fires LAST, silently reverting the
    // footer's pick. Flushing turns "last write wins by timer" into "last write
    // wins by the order the user did them", which is the only correct answer —
    // and gives the seam a production caller rather than a documented one.
    flushShellParamWrites();
    applyCloudseedPreset(id, Math.max(0, Math.min(CLOUDSEED_PRESETS.length - 1, slot)));
  }

  /** CLEAR TAIL — flush the tank. Not a param: nothing is stored, and there is
   *  nothing to undo. No-op before the audio engine boots. */
  function clearTail(): void {
    clearCloudseedTail({ engine: engineCtx.get(), node });
  }

  // Live DECAY readout in the footer — driven by LateLineDecay.
  let decayLabel = $derived(formatParameter(paramVal('late_line_decay'), CloudseedParam.LateLineDecay));
  // Live INPUT mix etc. labels (unused inline but available for testids).

  const inputs = portsFromDef(cloudseedDef.inputs, {
    in_l: 'IN L', in_r: 'IN R', dry_cv: 'DRY', early_cv: 'EARL', late_cv: 'LATE',
    input_mix_cv: 'IMIX', low_cut_cv: 'LOC', high_cut_cv: 'HIC', cross_seed_cv: 'XSED',
  });
  const outputs = portsFromDef(cloudseedDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });

  // Tap enabled / diffusion enabled / late diffusion / EQ enables.
  let tapOn = $derived(paramVal('tap_enabled') >= 0.5);
  let earlyDiffOn = $derived(paramVal('early_diffuse_enabled') >= 0.5);
  let lateDiffOn = $derived(paramVal('late_diffuse_enabled') >= 0.5);
  let eqLow = $derived(paramVal('eq_low_shelf_enabled') >= 0.5);
  let eqHigh = $derived(paramVal('eq_high_shelf_enabled') >= 0.5);
  let eqLp = $derived(paramVal('eq_lowpass_enabled') >= 0.5);
  let lowCutOn = $derived(paramVal('low_cut_enabled') >= 0.5);
  let highCutOn = $derived(paramVal('high_cut_enabled') >= 0.5);
  let latePost = $derived(paramVal('late_mode') >= 0.5);

  // Footer arrow handlers.
  function prevPreset(): void { applyPreset((presetIndex - 1 + CLOUDSEED_PRESETS.length) % CLOUDSEED_PRESETS.length); }
  function nextPreset(): void { applyPreset((presetIndex + 1) % CLOUDSEED_PRESETS.length); }

  // Reading the readouts for integer counts (DIFFUSION stages, LATE line count, LATE mode #).
  let earlyDiffCountLabel = $derived(formatParameter(paramVal('early_diffuse_count'), CloudseedParam.EarlyDiffuseCount));
  let lateLineCountLabel = $derived(formatParameter(paramVal('late_line_count'), CloudseedParam.LateLineCount));
  let lateDiffCountLabel = $derived(formatParameter(paramVal('late_diffuse_count'), CloudseedParam.LateDiffuseCount));
</script>

<div class="mod-card cloudseed-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CLOUDSEED" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={680}>
    <div class="panel-grid">
      <!-- TAPS panel -->
      <section class="panel" data-testid="cs-panel-taps">
        <header class="panel-head">
          <span class="panel-label">TAPS</span>
          <button type="button" class="pill" class:on={tapOn} data-testid="cs-tap-enabled" onclick={() => toggle('tap_enabled')}>{tapOn ? 'ON' : 'OFF'}</button>
        </header>
        <div class="knob-grid">
          <Knob value={paramVal('tap_count')}    min={pmin('tap_count')} max={pmax('tap_count')} defaultValue={pdef('tap_count')}  label="Count"     curve={pcurve('tap_count')} onchange={set('tap_count')} moduleId={id} paramId="tap_count"    readLive={live('tap_count')} />
          <Knob value={paramVal('tap_decay')}    min={pmin('tap_decay')} max={pmax('tap_decay')} defaultValue={pdef('tap_decay')}    label="Decay"     curve={pcurve('tap_decay')} onchange={set('tap_decay')} moduleId={id} paramId="tap_decay"    readLive={live('tap_decay')} />
          <Knob value={paramVal('tap_predelay')} min={pmin('tap_predelay')} max={pmax('tap_predelay')} defaultValue={pdef('tap_predelay')}    label="Pre-Delay" curve={pcurve('tap_predelay')} onchange={set('tap_predelay')} moduleId={id} paramId="tap_predelay" readLive={live('tap_predelay')} />
          <Knob value={paramVal('tap_length')}   min={pmin('tap_length')} max={pmax('tap_length')} defaultValue={pdef('tap_length')} label="Length"    curve={pcurve('tap_length')} onchange={set('tap_length')} moduleId={id} paramId="tap_length"   readLive={live('tap_length')} />
        </div>
      </section>

      <!-- DIFFUSION panel -->
      <section class="panel" data-testid="cs-panel-diffusion">
        <header class="panel-head">
          <span class="panel-label">DIFFUSION</span>
          <span class="num-readout" data-testid="cs-diff-count">{earlyDiffCountLabel}</span>
          <button type="button" class="pill" class:on={earlyDiffOn} data-testid="cs-diff-enabled" onclick={() => toggle('early_diffuse_enabled')}>{earlyDiffOn ? 'ON' : 'OFF'}</button>
        </header>
        <div class="knob-grid">
          <Knob value={paramVal('early_diffuse_delay')}    min={pmin('early_diffuse_delay')} max={pmax('early_diffuse_delay')} defaultValue={pdef('early_diffuse_delay')}  label="Delay"    curve={pcurve('early_diffuse_delay')} onchange={set('early_diffuse_delay')} moduleId={id} paramId="early_diffuse_delay"    readLive={live('early_diffuse_delay')} />
          <Knob value={paramVal('early_diffuse_mod_amt')}  min={pmin('early_diffuse_mod_amt')} max={pmax('early_diffuse_mod_amt')} defaultValue={pdef('early_diffuse_mod_amt')} label="Mod Amt"  curve={pcurve('early_diffuse_mod_amt')} onchange={set('early_diffuse_mod_amt')} moduleId={id} paramId="early_diffuse_mod_amt"  readLive={live('early_diffuse_mod_amt')} />
          <Knob value={paramVal('early_diffuse_feedback')} min={pmin('early_diffuse_feedback')} max={pmax('early_diffuse_feedback')} defaultValue={pdef('early_diffuse_feedback')} label="Feedback" curve={pcurve('early_diffuse_feedback')} onchange={set('early_diffuse_feedback')} moduleId={id} paramId="early_diffuse_feedback" readLive={live('early_diffuse_feedback')} />
          <Knob value={paramVal('early_diffuse_mod_rate')} min={pmin('early_diffuse_mod_rate')} max={pmax('early_diffuse_mod_rate')} defaultValue={pdef('early_diffuse_mod_rate')} label="Mod Rate" curve={pcurve('early_diffuse_mod_rate')} onchange={set('early_diffuse_mod_rate')} moduleId={id} paramId="early_diffuse_mod_rate" readLive={live('early_diffuse_mod_rate')} />
          <Knob value={paramVal('early_diffuse_count')}    min={pmin('early_diffuse_count')} max={pmax('early_diffuse_count')} defaultValue={pdef('early_diffuse_count')}  label="Stages"   curve={pcurve('early_diffuse_count')} onchange={set('early_diffuse_count')} moduleId={id} paramId="early_diffuse_count"    readLive={live('early_diffuse_count')} />
        </div>
      </section>

      <!-- LATE REFLECTIONS panel -->
      <section class="panel late" data-testid="cs-panel-late">
        <header class="panel-head">
          <span class="panel-label">LATE REFLECTIONS</span>
          <button type="button" class="pill" class:on={latePost} data-testid="cs-late-mode" onclick={() => toggle('late_mode')}>{latePost ? 'POST' : 'PRE'}</button>
          <span class="num-readout" data-testid="cs-late-lines">{lateLineCountLabel}</span>
          <button type="button" class="pill" class:on={lateDiffOn} data-testid="cs-late-diffuse-enabled" onclick={() => toggle('late_diffuse_enabled')}>{lateDiffOn ? 'ON' : 'OFF'}</button>
          <span class="num-readout" data-testid="cs-late-diff-count">{lateDiffCountLabel}</span>
        </header>
        <div class="knob-grid wide">
          <Knob value={paramVal('late_line_size')}        min={pmin('late_line_size')} max={pmax('late_line_size')} defaultValue={pdef('late_line_size')} label="Size"      curve={pcurve('late_line_size')} onchange={set('late_line_size')} moduleId={id} paramId="late_line_size"        readLive={live('late_line_size')} />
          <Knob value={paramVal('late_line_mod_amt')}     min={pmin('late_line_mod_amt')} max={pmax('late_line_mod_amt')} defaultValue={pdef('late_line_mod_amt')} label="Mod Amt"   curve={pcurve('late_line_mod_amt')} onchange={set('late_line_mod_amt')} moduleId={id} paramId="late_line_mod_amt"     readLive={live('late_line_mod_amt')} />
          <Knob value={paramVal('late_line_mod_rate')}    min={pmin('late_line_mod_rate')} max={pmax('late_line_mod_rate')} defaultValue={pdef('late_line_mod_rate')} label="Mod Rate"  curve={pcurve('late_line_mod_rate')} onchange={set('late_line_mod_rate')} moduleId={id} paramId="late_line_mod_rate"    readLive={live('late_line_mod_rate')} />
          <Knob value={paramVal('late_line_decay')}       min={pmin('late_line_decay')} max={pmax('late_line_decay')} defaultValue={pdef('late_line_decay')} label="Decay"     curve={pcurve('late_line_decay')} onchange={set('late_line_decay')} moduleId={id} paramId="late_line_decay"       readLive={live('late_line_decay')} />
          <Knob value={paramVal('late_diffuse_delay')}    min={pmin('late_diffuse_delay')} max={pmax('late_diffuse_delay')} defaultValue={pdef('late_diffuse_delay')} label="Diff Dly"  curve={pcurve('late_diffuse_delay')} onchange={set('late_diffuse_delay')} moduleId={id} paramId="late_diffuse_delay"    readLive={live('late_diffuse_delay')} />
          <Knob value={paramVal('late_diffuse_mod_amt')}  min={pmin('late_diffuse_mod_amt')} max={pmax('late_diffuse_mod_amt')} defaultValue={pdef('late_diffuse_mod_amt')} label="DMod Amt"  curve={pcurve('late_diffuse_mod_amt')} onchange={set('late_diffuse_mod_amt')} moduleId={id} paramId="late_diffuse_mod_amt"  readLive={live('late_diffuse_mod_amt')} />
          <Knob value={paramVal('late_diffuse_feedback')} min={pmin('late_diffuse_feedback')} max={pmax('late_diffuse_feedback')} defaultValue={pdef('late_diffuse_feedback')} label="DFeedback" curve={pcurve('late_diffuse_feedback')} onchange={set('late_diffuse_feedback')} moduleId={id} paramId="late_diffuse_feedback" readLive={live('late_diffuse_feedback')} />
          <Knob value={paramVal('late_diffuse_mod_rate')} min={pmin('late_diffuse_mod_rate')} max={pmax('late_diffuse_mod_rate')} defaultValue={pdef('late_diffuse_mod_rate')} label="DMod Rate" curve={pcurve('late_diffuse_mod_rate')} onchange={set('late_diffuse_mod_rate')} moduleId={id} paramId="late_diffuse_mod_rate" readLive={live('late_diffuse_mod_rate')} />
        </div>
      </section>

      <!-- EQUALISATION panel -->
      <section class="panel" data-testid="cs-panel-eq">
        <header class="panel-head">
          <span class="panel-label">EQUALISATION</span>
          <button type="button" class="pill" class:on={eqLow}  data-testid="cs-eq-low"  onclick={() => toggle('eq_low_shelf_enabled')}>{eqLow ? 'LS' : 'OFF'}</button>
          <button type="button" class="pill" class:on={eqHigh} data-testid="cs-eq-high" onclick={() => toggle('eq_high_shelf_enabled')}>{eqHigh ? 'HS' : 'OFF'}</button>
          <button type="button" class="pill" class:on={eqLp}   data-testid="cs-eq-lp"   onclick={() => toggle('eq_lowpass_enabled')}>{eqLp ? 'LP' : 'OFF'}</button>
        </header>
        <div class="knob-grid">
          <Knob value={paramVal('eq_low_freq')}  min={pmin('eq_low_freq')} max={pmax('eq_low_freq')} defaultValue={pdef('eq_low_freq')} label="Lo Freq" curve={pcurve('eq_low_freq')} onchange={set('eq_low_freq')} moduleId={id} paramId="eq_low_freq"  readLive={live('eq_low_freq')} />
          <Knob value={paramVal('eq_high_freq')} min={pmin('eq_high_freq')} max={pmax('eq_high_freq')} defaultValue={pdef('eq_high_freq')} label="Hi Freq" curve={pcurve('eq_high_freq')} onchange={set('eq_high_freq')} moduleId={id} paramId="eq_high_freq" readLive={live('eq_high_freq')} />
          <Knob value={paramVal('eq_cutoff')}    min={pmin('eq_cutoff')} max={pmax('eq_cutoff')} defaultValue={pdef('eq_cutoff')} label="Cutoff"  curve={pcurve('eq_cutoff')} onchange={set('eq_cutoff')} moduleId={id} paramId="eq_cutoff"    readLive={live('eq_cutoff')} />
          <Knob value={paramVal('eq_low_gain')}  min={pmin('eq_low_gain')} max={pmax('eq_low_gain')} defaultValue={pdef('eq_low_gain')} label="Lo Gain" curve={pcurve('eq_low_gain')} onchange={set('eq_low_gain')} moduleId={id} paramId="eq_low_gain"  readLive={live('eq_low_gain')} />
          <Knob value={paramVal('eq_high_gain')} min={pmin('eq_high_gain')} max={pmax('eq_high_gain')} defaultValue={pdef('eq_high_gain')} label="Hi Gain" curve={pcurve('eq_high_gain')} onchange={set('eq_high_gain')} moduleId={id} paramId="eq_high_gain" readLive={live('eq_high_gain')} />
        </div>
      </section>

      <!-- BOTTOM: output mix faders + utility knobs -->
      <section class="panel bottom" data-testid="cs-panel-out">
        <div class="bottom-grid">
          <div class="bottom-faders">
            <NeonFader value={paramVal('dry_out')}   min={pmin('dry_out')} max={pmax('dry_out')} defaultValue={pdef('dry_out')} label="Dry"   curve={pcurve('dry_out')} onchange={set('dry_out')} moduleId={id} paramId="dry_out"   readLive={live('dry_out')} />
            <NeonFader value={paramVal('early_out')} min={pmin('early_out')} max={pmax('early_out')} defaultValue={pdef('early_out')}    label="Early" curve={pcurve('early_out')} onchange={set('early_out')} moduleId={id} paramId="early_out" readLive={live('early_out')} />
            <NeonFader value={paramVal('late_out')}  min={pmin('late_out')} max={pmax('late_out')} defaultValue={pdef('late_out')} label="Late"  curve={pcurve('late_out')} onchange={set('late_out')} moduleId={id} paramId="late_out"  readLive={live('late_out')} />
          </div>
          <div class="bottom-utility">
            <div class="util-toggles">
              <button type="button" class="pill" class:on={lowCutOn}  data-testid="cs-loc-enabled" onclick={() => toggle('low_cut_enabled')}>{lowCutOn ? 'ON' : 'OFF'}</button>
              <button type="button" class="pill" class:on={highCutOn} data-testid="cs-hic-enabled" onclick={() => toggle('high_cut_enabled')}>{highCutOn ? 'ON' : 'OFF'}</button>
            </div>
            <div class="util-knobs">
              <Knob value={paramVal('input_mix')}  min={pmin('input_mix')} max={pmax('input_mix')} defaultValue={pdef('input_mix')} label="In Mix"   curve={pcurve('input_mix')} onchange={set('input_mix')} moduleId={id} paramId="input_mix"  readLive={live('input_mix')} />
              <Knob value={paramVal('high_cut')}   min={pmin('high_cut')} max={pmax('high_cut')} defaultValue={pdef('high_cut')} label="Hi Cut"   curve={pcurve('high_cut')} onchange={set('high_cut')} moduleId={id} paramId="high_cut"   readLive={live('high_cut')} />
              <Knob value={paramVal('low_cut')}    min={pmin('low_cut')} max={pmax('low_cut')} defaultValue={pdef('low_cut')} label="Lo Cut"   curve={pcurve('low_cut')} onchange={set('low_cut')} moduleId={id} paramId="low_cut"    readLive={live('low_cut')} />
              <Knob value={paramVal('cross_seed')} min={pmin('cross_seed')} max={pmax('cross_seed')} defaultValue={pdef('cross_seed')}    label="X-Seed"   curve={pcurve('cross_seed')} onchange={set('cross_seed')} moduleId={id} paramId="cross_seed" readLive={live('cross_seed')} />
            </div>
          </div>
        </div>
      </section>

      <!-- FOOTER — preset slots + name + DECAY readout -->
      <footer class="preset-bar" data-testid="cs-preset-bar">
        <div class="slots">
          {#each CLOUDSEED_PRESETS as p, i (i)}
            <button
              type="button"
              class="slot"
              class:active={i === presetIndex}
              data-testid={`cs-preset-slot-${i}`}
              onclick={() => applyPreset(i)}
              title={p.name}
            >{String(i + 1).padStart(3, '0')}</button>
          {/each}
        </div>
        <button type="button" class="arrow" data-testid="cs-preset-prev" onclick={prevPreset}>‹</button>
        <span class="preset-name" data-testid="cs-preset-name">{CLOUDSEED_PRESETS[presetIndex]?.name ?? '—'}</span>
        <button type="button" class="arrow" data-testid="cs-preset-next" onclick={nextPreset}>›</button>
        <span class="decay-readout" data-testid="cs-decay-readout">{decayLabel}</span>
        <!-- CLEAR TAIL (controlFamily 'cloudseed-clear'): flushes every delay
             line / diffuser / shelf / lowpass in the tank. The worklet has
             always handled `clearBuffers`; nothing had ever sent it. -->
        <button
          type="button"
          class="pill clear"
          data-testid={`cs-clear-tail-${id}-1`}
          title="Clear tail — flush the reverb tank (nothing is stored; not undoable)"
          onclick={clearTail}
        >CLEAR</button>
      </footer>
    </div>
  </PatchPanel>
  <OssAttribution author={cloudseedDef.ossAttribution?.author} />
</div>

<style>
  .cloudseed-card {
    width: 680px;
    background: var(--cloudseed-bg, var(--surface-2, #1a2530));
    color: var(--text, #e0e8f0);
  }  .panel-grid {
    display: grid;
    grid-template-columns: 1fr 1.2fr 2fr 1.4fr;
    grid-template-rows: auto auto auto;
    gap: 6px;
    padding: 6px 8px;
  }
  .panel {
    border: 1px solid var(--border-dim, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    background: var(--surface-deep, rgba(0, 0, 0, 0.15));
    padding: 4px 6px;
    min-width: 0;
  }
  .panel.late {
    grid-column: span 1;
  }
  .panel.bottom {
    grid-column: 1 / -1;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #9bb0c5);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .panel-label { flex: 1; }
  .pill {
    background: var(--surface-deep, #0f1820);
    color: var(--text-dim, #8aa1b8);
    border: 1px solid var(--border-dim, rgba(255, 255, 255, 0.18));
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.55rem;
    letter-spacing: 0.1em;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
  }
  .pill.on {
    background: var(--accent, #5da9d6);
    color: #0a1218;
    border-color: var(--accent, #5da9d6);
  }
  .num-readout {
    font-family: var(--font-mono, monospace);
    color: var(--text, #e0e8f0);
    font-size: 0.7rem;
    padding: 0 4px;
    min-width: 20px;
    text-align: center;
  }
  .knob-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px 6px;
    padding: 2px 0;
    justify-items: center;
  }
  .knob-grid.wide { grid-template-columns: repeat(4, 1fr); }

  .bottom-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    padding: 4px 0;
  }
  .bottom-faders {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .bottom-utility {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .util-toggles {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
  .util-knobs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    justify-items: center;
  }
  .preset-bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
    border-top: 1px solid var(--border-dim, rgba(255, 255, 255, 0.12));
    background: var(--surface-deep, rgba(0, 0, 0, 0.2));
  }
  .slots { display: flex; gap: 4px; }
  .slot {
    background: var(--surface-deep, #0f1820);
    color: var(--text-dim, #8aa1b8);
    border: 1px solid var(--border-dim, rgba(255, 255, 255, 0.18));
    border-radius: 2px;
    padding: 1px 4px;
    font-size: 0.6rem;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
  }
  .slot.active {
    background: var(--accent, #5da9d6);
    color: #0a1218;
    border-color: var(--accent, #5da9d6);
  }
  .arrow {
    background: transparent;
    border: none;
    color: var(--text-dim, #8aa1b8);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .preset-name {
    flex: 1;
    color: var(--text, #e0e8f0);
    letter-spacing: 0.04em;
    text-align: center;
  }
  .decay-readout {
    color: var(--accent, #5da9d6);
    font-weight: 600;
  }
  .pill.clear {
    margin-left: 6px;
    flex: none;
  }
</style>
