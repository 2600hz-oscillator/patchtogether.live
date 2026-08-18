<script lang="ts">
  // SidecarCard — stereo sidechain ducker card. Standard fader card
  // pattern (mirrors ResofilterCard / CofefveCard). 9 knobs in two
  // rows: threshold/ratio/knee/makeup on the top row, attack/release/
  // envMag/inputLevel/sc_hpf on the bottom row. PatchPanel surfaces the 7
  // inputs (audio L/R, sc L/R, threshold_cv, env_mag_cv, input_level_cv) +
  // 4 outputs (audio L/R, env_out, env_inv_out).
  //
  // Input Lvl is the sidechain input volume: 0–200% (0.0–2.0 gain, default
  // 100%). Applied to the SC signal before ducking so a quiet pad can be
  // boosted into the mix.
  //
  // env_out + env_inv_out are typed `cv` so they connect to any
  // CV-family sink (STEREOVCA.strength, ADSR-style consumers).
  // Importantly, env_out has NO HARD CLAMP — at envMag>1 it can exceed
  // 1.0; downstream modules in this codebase tolerate this in the same
  // way they tolerate any audio-rate signal exceeding ±1.

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { sidecarDef } from '$lib/audio/modules/sidecar';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import OssAttribution from './OssAttribution.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(sidecarDef, () => id, () => node);

  // RANGE + CURVE COME FROM THE DEF, never re-typed here. This card carried
  // NINE hand-typed `min`/`max` pairs — the most of any card in its batch —
  // and they all AGREED, which is exactly why it is worth binding: a card that
  // restates a range is one edit away from the backdraft class, where the card
  // writes values the contract forbids and every def-reading gate is blind.
  //
  // `units` is deliberately NOT bound (the AnalogVcoCard shape: range-bound,
  // held to the value-wise curve-agreement clause). Binding it would start
  // painting unit suffixes on nine faders that have never had them, which is a
  // look change to a legacy card in a faceplate PR — and `inputLevel`'s `%`
  // needs its `format` to read correctly (see the def), so the two would have
  // to land together with an owner preview.
  const P = {
    threshold: paramSpec(sidecarDef, 'threshold'),
    ratio: paramSpec(sidecarDef, 'ratio'),
    attack: paramSpec(sidecarDef, 'attack'),
    release: paramSpec(sidecarDef, 'release'),
    knee: paramSpec(sidecarDef, 'knee'),
    envMag: paramSpec(sidecarDef, 'envMag'),
    inputLevel: paramSpec(sidecarDef, 'inputLevel'),
    makeup: paramSpec(sidecarDef, 'makeup'),
    sc_hpf: paramSpec(sidecarDef, 'sc_hpf'),
  };

  // Build a defaults map by id so we don't depend on the param order in
  // the def array (defensive against future re-ordering).
  const defaults = Object.fromEntries(
    sidecarDef.params.map((p) => [p.id, p.defaultValue] as const),
  );

  let threshold = $derived(node?.params.threshold ?? defaults.threshold);
  let ratio     = $derived(node?.params.ratio     ?? defaults.ratio);
  let attack    = $derived(node?.params.attack    ?? defaults.attack);
  let release   = $derived(node?.params.release   ?? defaults.release);
  let knee      = $derived(node?.params.knee      ?? defaults.knee);
  let envMag    = $derived(node?.params.envMag     ?? defaults.envMag);
  let inputLvl  = $derived(node?.params.inputLevel ?? defaults.inputLevel);
  let makeup    = $derived(node?.params.makeup     ?? defaults.makeup);
  let scHpf     = $derived(node?.params.sc_hpf     ?? defaults.sc_hpf);


  const inputs = portsFromDef(sidecarDef.inputs, {
    audio_l_in: 'AUD L', audio_r_in: 'AUD R', sc_l_in: 'SC L', sc_r_in: 'SC R',
    threshold_cv: 'THR CV', env_mag_cv: 'MAG CV', input_level_cv: 'LVL CV',
  });
  const outputs = portsFromDef(sidecarDef.outputs, {
    audio_l_out: 'OUT L', audio_r_out: 'OUT R', env_out: 'ENV', env_inv_out: 'ENV INV',
  });
</script>

<div class="mod-card sidecar-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SIDECAR" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={threshold} min={P.threshold.min} max={P.threshold.max} defaultValue={P.threshold.defaultValue} label="Thresh" curve={P.threshold.curve} onchange={set('threshold')} moduleId={id} paramId="threshold" readLive={live('threshold')} />
      <NeonFader value={ratio}     min={P.ratio.min}     max={P.ratio.max}     defaultValue={P.ratio.defaultValue}     label="Ratio"  curve={P.ratio.curve}     onchange={set('ratio')}     moduleId={id} paramId="ratio"     readLive={live('ratio')} />
      <NeonFader value={knee}      min={P.knee.min}      max={P.knee.max}      defaultValue={P.knee.defaultValue}      label="Knee"   curve={P.knee.curve}      onchange={set('knee')}      moduleId={id} paramId="knee"      readLive={live('knee')} />
      <NeonFader value={makeup}    min={P.makeup.min}    max={P.makeup.max}    defaultValue={P.makeup.defaultValue}    label="Makeup" curve={P.makeup.curve}    onchange={set('makeup')}    moduleId={id} paramId="makeup"    readLive={live('makeup')} />
    </div>
    <div class="fader-row">
      <NeonFader value={attack}    min={P.attack.min}     max={P.attack.max}     defaultValue={P.attack.defaultValue}     label="Att"    curve={P.attack.curve}     onchange={set('attack')}    moduleId={id} paramId="attack"    readLive={live('attack')} />
      <NeonFader value={release}   min={P.release.min}    max={P.release.max}    defaultValue={P.release.defaultValue}    label="Rel"    curve={P.release.curve}    onchange={set('release')}   moduleId={id} paramId="release"   readLive={live('release')} />
      <NeonFader value={envMag}    min={P.envMag.min}     max={P.envMag.max}     defaultValue={P.envMag.defaultValue}     label="EnvMag" curve={P.envMag.curve}     onchange={set('envMag')}     moduleId={id} paramId="envMag"     readLive={live('envMag')} />
      <!-- ⚠ THE ONE FADER THAT CHANGES WHAT IT PRINTS, and the gate demanded it
           (card-range-source: "a control whose param declares `format` must
           pass formatValue — otherwise the card prints one law and the dock
           prints another"). `inputLevel` is a 0..2 GAIN carrying `units: '%'`,
           so this readout used to say `1.00` for what the module calls 100 %,
           and a faceplate reading the ParamDef would have said `1.00 %`. Both
           surfaces now print `100 %` from the def's own formatter. -->
      <NeonFader value={inputLvl}  min={P.inputLevel.min} max={P.inputLevel.max} defaultValue={P.inputLevel.defaultValue} label="In Lvl" curve={P.inputLevel.curve} formatValue={P.inputLevel.format} onchange={set('inputLevel')} moduleId={id} paramId="inputLevel" readLive={live('inputLevel')} />
      <NeonFader value={scHpf}     min={P.sc_hpf.min}     max={P.sc_hpf.max}     defaultValue={P.sc_hpf.defaultValue}     label="SC HPF" curve={P.sc_hpf.curve}     onchange={set('sc_hpf')}     moduleId={id} paramId="sc_hpf"     readLive={live('sc_hpf')} />
    </div>
  </PatchPanel>

  <OssAttribution author={sidecarDef.ossAttribution?.author ?? ''} />
</div>

<style>
  .sidecar-card { width: 380px; min-height: 240px; }
  .sidecar-card .fader-row { padding: 0 14px; display: flex; gap: 10px; margin-bottom: 6px; }
</style>
