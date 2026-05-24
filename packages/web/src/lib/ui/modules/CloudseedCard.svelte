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
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    cloudseedDef,
    CLOUDSEED_PRESETS,
    formatParameter,
    CloudseedParam,
  } from '$lib/audio/modules/cloudseed';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return cloudseedDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  function toggle(k: string): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params[k] = paramVal(k) >= 0.5 ? 0 : 1;
  }

  // Preset footer plumbing — applyPreset writes all preset values into the
  // patch graph (engine factory pushes them through to the worklet via
  // setParam). The preset_index param is the one piece of multiplayer
  // state that drives the footer's selected-slot rendering.
  let presetIndex = $derived(Math.round(paramVal('preset_index')) | 0);
  function applyPreset(slot: number): void {
    const idx = Math.max(0, Math.min(CLOUDSEED_PRESETS.length - 1, slot));
    const preset = CLOUDSEED_PRESETS[idx];
    if (!preset) return;
    const t = patch.nodes[id]; if (!t) return;
    // Map C++ cppId → our string id, then write into patch.params.
    for (const [cppIdStr, v] of Object.entries(preset.values)) {
      const cppId = Number(cppIdStr);
      const def = cloudseedDef.params.find((p) => {
        // Find the param whose default index matches the cppId, by name.
        // Macro AudioParams use string names that don't directly include
        // the cppId; the message-port params do (see CLOUDSEED_MESSAGE_PARAMS).
        // For correctness we look up by name → cppId mapping table.
        return cppIdToParamId(cppId) === p.id;
      });
      if (!def) continue;
      t.params[def.id] = v;
    }
    t.params.preset_index = idx;
  }

  // C++ cppId → string-id mapping. Macros first, then message-port params.
  function cppIdToParamId(cppId: number): string | null {
    switch (cppId) {
      case CloudseedParam.DryOut:    return 'dry_out';
      case CloudseedParam.EarlyOut:  return 'early_out';
      case CloudseedParam.LateOut:   return 'late_out';
      case CloudseedParam.InputMix:  return 'input_mix';
      case CloudseedParam.LowCut:    return 'low_cut';
      case CloudseedParam.HighCut:   return 'high_cut';
      case CloudseedParam.EqCrossSeed: return 'cross_seed';
      case CloudseedParam.Interpolation:         return 'interpolation';
      case CloudseedParam.LowCutEnabled:         return 'low_cut_enabled';
      case CloudseedParam.HighCutEnabled:        return 'high_cut_enabled';
      case CloudseedParam.TapEnabled:            return 'tap_enabled';
      case CloudseedParam.TapCount:              return 'tap_count';
      case CloudseedParam.TapDecay:              return 'tap_decay';
      case CloudseedParam.TapPredelay:           return 'tap_predelay';
      case CloudseedParam.TapLength:             return 'tap_length';
      case CloudseedParam.EarlyDiffuseEnabled:   return 'early_diffuse_enabled';
      case CloudseedParam.EarlyDiffuseCount:     return 'early_diffuse_count';
      case CloudseedParam.EarlyDiffuseDelay:     return 'early_diffuse_delay';
      case CloudseedParam.EarlyDiffuseModAmount: return 'early_diffuse_mod_amt';
      case CloudseedParam.EarlyDiffuseFeedback:  return 'early_diffuse_feedback';
      case CloudseedParam.EarlyDiffuseModRate:   return 'early_diffuse_mod_rate';
      case CloudseedParam.LateMode:              return 'late_mode';
      case CloudseedParam.LateLineCount:         return 'late_line_count';
      case CloudseedParam.LateDiffuseEnabled:    return 'late_diffuse_enabled';
      case CloudseedParam.LateDiffuseCount:      return 'late_diffuse_count';
      case CloudseedParam.LateLineSize:          return 'late_line_size';
      case CloudseedParam.LateLineModAmount:     return 'late_line_mod_amt';
      case CloudseedParam.LateDiffuseDelay:      return 'late_diffuse_delay';
      case CloudseedParam.LateDiffuseModAmount:  return 'late_diffuse_mod_amt';
      case CloudseedParam.LateLineDecay:         return 'late_line_decay';
      case CloudseedParam.LateLineModRate:       return 'late_line_mod_rate';
      case CloudseedParam.LateDiffuseFeedback:   return 'late_diffuse_feedback';
      case CloudseedParam.LateDiffuseModRate:    return 'late_diffuse_mod_rate';
      case CloudseedParam.EqLowShelfEnabled:     return 'eq_low_shelf_enabled';
      case CloudseedParam.EqHighShelfEnabled:    return 'eq_high_shelf_enabled';
      case CloudseedParam.EqLowpassEnabled:      return 'eq_lowpass_enabled';
      case CloudseedParam.EqLowFreq:             return 'eq_low_freq';
      case CloudseedParam.EqHighFreq:            return 'eq_high_freq';
      case CloudseedParam.EqCutoff:              return 'eq_cutoff';
      case CloudseedParam.EqLowGain:             return 'eq_low_gain';
      case CloudseedParam.EqHighGain:            return 'eq_high_gain';
      case CloudseedParam.SeedTap:               return 'seed_tap';
      case CloudseedParam.SeedDiffusion:         return 'seed_diffusion';
      case CloudseedParam.SeedDelay:             return 'seed_delay';
      case CloudseedParam.SeedPostDiffusion:     return 'seed_post_diffusion';
    }
    return null;
  }

  // Live DECAY readout in the footer — driven by LateLineDecay.
  let decayLabel = $derived(formatParameter(paramVal('late_line_decay'), CloudseedParam.LateLineDecay));
  // Live INPUT mix etc. labels (unused inline but available for testids).

  const inputs: PortDescriptor[] = [
    { id: 'in_l',          label: 'IN L',  cable: 'audio' },
    { id: 'in_r',          label: 'IN R',  cable: 'audio' },
    { id: 'dry_cv',        label: 'DRY',   cable: 'cv' },
    { id: 'early_cv',      label: 'EARL',  cable: 'cv' },
    { id: 'late_cv',       label: 'LATE',  cable: 'cv' },
    { id: 'input_mix_cv',  label: 'IMIX',  cable: 'cv' },
    { id: 'low_cut_cv',    label: 'LOC',   cable: 'cv' },
    { id: 'high_cut_cv',   label: 'HIC',   cable: 'cv' },
    { id: 'cross_seed_cv', label: 'XSED',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];

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
  <header class="title">CLOUDSEED</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={680}>
    <div class="panel-grid">
      <!-- TAPS panel -->
      <section class="panel" data-testid="cs-panel-taps">
        <header class="panel-head">
          <span class="panel-label">TAPS</span>
          <button type="button" class="pill" class:on={tapOn} data-testid="cs-tap-enabled" onclick={() => toggle('tap_enabled')}>{tapOn ? 'ON' : 'OFF'}</button>
        </header>
        <div class="knob-grid">
          <Knob value={paramVal('tap_count')}    min={0} max={1} defaultValue={0.2}  label="Count"     curve="linear" onchange={set('tap_count')} moduleId={id} paramId="tap_count"    readLive={live('tap_count')} />
          <Knob value={paramVal('tap_decay')}    min={0} max={1} defaultValue={1}    label="Decay"     curve="linear" onchange={set('tap_decay')} moduleId={id} paramId="tap_decay"    readLive={live('tap_decay')} />
          <Knob value={paramVal('tap_predelay')} min={0} max={1} defaultValue={0}    label="Pre-Delay" curve="linear" onchange={set('tap_predelay')} moduleId={id} paramId="tap_predelay" readLive={live('tap_predelay')} />
          <Knob value={paramVal('tap_length')}   min={0} max={1} defaultValue={0.98} label="Length"    curve="linear" onchange={set('tap_length')} moduleId={id} paramId="tap_length"   readLive={live('tap_length')} />
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
          <Knob value={paramVal('early_diffuse_delay')}    min={0} max={1} defaultValue={0.3}  label="Delay"    curve="linear" onchange={set('early_diffuse_delay')} moduleId={id} paramId="early_diffuse_delay"    readLive={live('early_diffuse_delay')} />
          <Knob value={paramVal('early_diffuse_mod_amt')}  min={0} max={1} defaultValue={0.14} label="Mod Amt"  curve="linear" onchange={set('early_diffuse_mod_amt')} moduleId={id} paramId="early_diffuse_mod_amt"  readLive={live('early_diffuse_mod_amt')} />
          <Knob value={paramVal('early_diffuse_feedback')} min={0} max={1} defaultValue={0.77} label="Feedback" curve="linear" onchange={set('early_diffuse_feedback')} moduleId={id} paramId="early_diffuse_feedback" readLive={live('early_diffuse_feedback')} />
          <Knob value={paramVal('early_diffuse_mod_rate')} min={0} max={1} defaultValue={0.25} label="Mod Rate" curve="linear" onchange={set('early_diffuse_mod_rate')} moduleId={id} paramId="early_diffuse_mod_rate" readLive={live('early_diffuse_mod_rate')} />
          <Knob value={paramVal('early_diffuse_count')}    min={0} max={1} defaultValue={0.3}  label="Stages"   curve="linear" onchange={set('early_diffuse_count')} moduleId={id} paramId="early_diffuse_count"    readLive={live('early_diffuse_count')} />
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
          <Knob value={paramVal('late_line_size')}        min={0} max={1} defaultValue={0.47} label="Size"      curve="linear" onchange={set('late_line_size')} moduleId={id} paramId="late_line_size"        readLive={live('late_line_size')} />
          <Knob value={paramVal('late_line_mod_amt')}     min={0} max={1} defaultValue={0.27} label="Mod Amt"   curve="linear" onchange={set('late_line_mod_amt')} moduleId={id} paramId="late_line_mod_amt"     readLive={live('late_line_mod_amt')} />
          <Knob value={paramVal('late_line_mod_rate')}    min={0} max={1} defaultValue={0.23} label="Mod Rate"  curve="linear" onchange={set('late_line_mod_rate')} moduleId={id} paramId="late_line_mod_rate"    readLive={live('late_line_mod_rate')} />
          <Knob value={paramVal('late_line_decay')}       min={0} max={1} defaultValue={0.63} label="Decay"     curve="linear" onchange={set('late_line_decay')} moduleId={id} paramId="late_line_decay"       readLive={live('late_line_decay')} />
          <Knob value={paramVal('late_diffuse_delay')}    min={0} max={1} defaultValue={0.24} label="Diff Dly"  curve="linear" onchange={set('late_diffuse_delay')} moduleId={id} paramId="late_diffuse_delay"    readLive={live('late_diffuse_delay')} />
          <Knob value={paramVal('late_diffuse_mod_amt')}  min={0} max={1} defaultValue={0.15} label="DMod Amt"  curve="linear" onchange={set('late_diffuse_mod_amt')} moduleId={id} paramId="late_diffuse_mod_amt"  readLive={live('late_diffuse_mod_amt')} />
          <Knob value={paramVal('late_diffuse_feedback')} min={0} max={1} defaultValue={0.85} label="DFeedback" curve="linear" onchange={set('late_diffuse_feedback')} moduleId={id} paramId="late_diffuse_feedback" readLive={live('late_diffuse_feedback')} />
          <Knob value={paramVal('late_diffuse_mod_rate')} min={0} max={1} defaultValue={0.17} label="DMod Rate" curve="linear" onchange={set('late_diffuse_mod_rate')} moduleId={id} paramId="late_diffuse_mod_rate" readLive={live('late_diffuse_mod_rate')} />
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
          <Knob value={paramVal('eq_low_freq')}  min={0} max={1} defaultValue={0.39} label="Lo Freq" curve="linear" onchange={set('eq_low_freq')} moduleId={id} paramId="eq_low_freq"  readLive={live('eq_low_freq')} />
          <Knob value={paramVal('eq_high_freq')} min={0} max={1} defaultValue={0.51} label="Hi Freq" curve="linear" onchange={set('eq_high_freq')} moduleId={id} paramId="eq_high_freq" readLive={live('eq_high_freq')} />
          <Knob value={paramVal('eq_cutoff')}    min={0} max={1} defaultValue={0.97} label="Cutoff"  curve="linear" onchange={set('eq_cutoff')} moduleId={id} paramId="eq_cutoff"    readLive={live('eq_cutoff')} />
          <Knob value={paramVal('eq_low_gain')}  min={0} max={1} defaultValue={0.56} label="Lo Gain" curve="linear" onchange={set('eq_low_gain')} moduleId={id} paramId="eq_low_gain"  readLive={live('eq_low_gain')} />
          <Knob value={paramVal('eq_high_gain')} min={0} max={1} defaultValue={0.77} label="Hi Gain" curve="linear" onchange={set('eq_high_gain')} moduleId={id} paramId="eq_high_gain" readLive={live('eq_high_gain')} />
        </div>
      </section>

      <!-- BOTTOM: output mix faders + utility knobs -->
      <section class="panel bottom" data-testid="cs-panel-out">
        <div class="bottom-grid">
          <div class="bottom-faders">
            <Fader value={paramVal('dry_out')}   min={0} max={1} defaultValue={0.87} label="Dry"   curve="linear" onchange={set('dry_out')} moduleId={id} paramId="dry_out"   readLive={live('dry_out')} />
            <Fader value={paramVal('early_out')} min={0} max={1} defaultValue={0}    label="Early" curve="linear" onchange={set('early_out')} moduleId={id} paramId="early_out" readLive={live('early_out')} />
            <Fader value={paramVal('late_out')}  min={0} max={1} defaultValue={0.66} label="Late"  curve="linear" onchange={set('late_out')} moduleId={id} paramId="late_out"  readLive={live('late_out')} />
          </div>
          <div class="bottom-utility">
            <div class="util-toggles">
              <button type="button" class="pill" class:on={lowCutOn}  data-testid="cs-loc-enabled" onclick={() => toggle('low_cut_enabled')}>{lowCutOn ? 'ON' : 'OFF'}</button>
              <button type="button" class="pill" class:on={highCutOn} data-testid="cs-hic-enabled" onclick={() => toggle('high_cut_enabled')}>{highCutOn ? 'ON' : 'OFF'}</button>
            </div>
            <div class="util-knobs">
              <Knob value={paramVal('input_mix')}  min={0} max={1} defaultValue={0.23} label="In Mix"   curve="linear" onchange={set('input_mix')} moduleId={id} paramId="input_mix"  readLive={live('input_mix')} />
              <Knob value={paramVal('high_cut')}   min={0} max={1} defaultValue={0.29} label="Hi Cut"   curve="linear" onchange={set('high_cut')} moduleId={id} paramId="high_cut"   readLive={live('high_cut')} />
              <Knob value={paramVal('low_cut')}    min={0} max={1} defaultValue={0.64} label="Lo Cut"   curve="linear" onchange={set('low_cut')} moduleId={id} paramId="low_cut"    readLive={live('low_cut')} />
              <Knob value={paramVal('cross_seed')} min={0} max={1} defaultValue={0}    label="X-Seed"   curve="linear" onchange={set('cross_seed')} moduleId={id} paramId="cross_seed" readLive={live('cross_seed')} />
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
      </footer>
    </div>
  </PatchPanel>
  <OssAttribution author={cloudseedDef.ossAttribution?.author} />
</div>

<style>
  .cloudseed-card {
    width: 680px;
    min-height: 380px;
    background: var(--cloudseed-bg, var(--surface-2, #1a2530));
    color: var(--text, #e0e8f0);
  }
  .cloudseed-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.95rem;
    letter-spacing: 0.08em;
    padding: 6px 12px;
  }
  .panel-grid {
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
</style>
