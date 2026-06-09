<script lang="ts">
  // TreeohvoxCard — TB-303 voice slice UI.
  //
  // Layout (2 rows of 3 knobs to keep card width sensible):
  //   row 1:  [ TUNE ]   [ CUTOFF ]  [ RESO ]
  //   row 2:  [ ENV  ]   [ DECAY  ]  [ ACCENT ]
  //
  // The 4 future-303 features (sequencer, transpose, slide, smiley) are
  // intentionally NOT on this card — they ship with the full 404 module.
  // This card is exclusively the VOICE.
  //
  // Patch panel:
  //   inputs:  PITCH, GATE, ACCENT (audio-rate), then TUNE/CUTOFF/RES/ENV/DECAY/ACCENT CV (CV)
  //   outputs: OUT
  //
  // Visual tone matches the TD-3's "acid yellow on dark" — a hint of the
  // canonical yellow stripe + a warmer body than RESOFILTER's slate. The
  // full TD-3 colourway (yellow/orange with the smiley badge) is queued
  // for 404.
  //
  // NOTE: each <Knob> spells out moduleId={id} + paramId="..." explicitly
  // so the static MIDI-Learn wiring audit (midi-learn-wiring-audit.test.ts)
  // can verify by regex.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { treeohvoxDef } from '$lib/audio/modules/treeohvox';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    treeohvoxDef.params.find((p) => p.id === pid)!.defaultValue;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }

  const set = (pid: string) => (v: number) => {
    setNodeParam(id, pid, v);
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  const inputs: PortDescriptor[] = [
    // Audio-rate signals — patch from a sequencer / keyboard / clock.
    { id: 'pitch_in',  label: 'PITCH',  cable: 'pitch' },
    { id: 'gate_in',   label: 'GATE',   cable: 'gate' },
    { id: 'accent_in', label: 'ACCNT',  cable: 'gate' },
    // CV inputs targeting each knob's AudioParam.
    { id: 'tune_cv',   label: 'TUNE',   cable: 'cv' },
    { id: 'cutoff_cv', label: 'CUT',    cable: 'cv' },
    { id: 'res_cv',    label: 'RES',    cable: 'cv' },
    { id: 'env_cv',    label: 'ENV',    cable: 'cv' },
    { id: 'decay_cv',  label: 'DCY',    cable: 'cv' },
    { id: 'accent_cv', label: 'ACC',    cable: 'cv' },
    { id: 'waveform_cv', label: 'WAVE', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio_out', label: 'OUT', cable: 'audio' },
  ];
</script>

<div class="mod-card treeohvox-card">
  <div class="stripe" style="background: var(--treeohvox-stripe, #f4b400);"></div>
  <ModuleTitle {id} {data} defaultLabel="TREE.oh.VOX" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={340}>
    <div class="tv-body">
      <!-- Row 1: pitch / brightness / character -->
      <div class="knob-row">
        <Knob
          value={paramVal('tune')}
          min={-12}
          max={12}
          defaultValue={defaultFor('tune')}
          label="Tune"
          units="st"
          curve="linear"
          onchange={set('tune')}
          moduleId={id}
          paramId="tune"
          readLive={live('tune')}
        />
        <Knob
          value={paramVal('cutoff')}
          min={40}
          max={6000}
          defaultValue={defaultFor('cutoff')}
          label="Cutoff"
          units="Hz"
          curve="log"
          onchange={set('cutoff')}
          moduleId={id}
          paramId="cutoff"
          readLive={live('cutoff')}
        />
        <Knob
          value={paramVal('resonance')}
          min={0}
          max={1}
          defaultValue={defaultFor('resonance')}
          label="Reso"
          curve="linear"
          onchange={set('resonance')}
          moduleId={id}
          paramId="resonance"
          readLive={live('resonance')}
        />
      </div>
      <!-- Row 2: envelope shape / accent -->
      <div class="knob-row">
        <Knob
          value={paramVal('envelope')}
          min={0}
          max={1}
          defaultValue={defaultFor('envelope')}
          label="EnvMod"
          curve="linear"
          onchange={set('envelope')}
          moduleId={id}
          paramId="envelope"
          readLive={live('envelope')}
        />
        <Knob
          value={paramVal('decay')}
          min={50}
          max={3000}
          defaultValue={defaultFor('decay')}
          label="Decay"
          units="ms"
          curve="log"
          onchange={set('decay')}
          moduleId={id}
          paramId="decay"
          readLive={live('decay')}
        />
        <Knob
          value={paramVal('accent')}
          min={0}
          max={1}
          defaultValue={defaultFor('accent')}
          label="Accent"
          curve="linear"
          onchange={set('accent')}
          moduleId={id}
          paramId="accent"
          readLive={live('accent')}
        />
        <Knob
          value={paramVal('waveform')}
          min={0}
          max={1}
          defaultValue={defaultFor('waveform')}
          label="Wave"
          curve="linear"
          onchange={set('waveform')}
          moduleId={id}
          paramId="waveform"
          readLive={live('waveform')}
        />
      </div>
    </div>
  </PatchPanel>

  <OssAttribution text="TB-303 voice ported from Robin Schmidt's Open303 (MIT)" />
</div>

<style>
  .treeohvox-card {
    width: 340px;
    min-height: 240px;
    /* Warm dark body — leans toward the TD-3's acid-yellow front panel
       without going full kitsch (the smiley + full colourway lands with
       the 404 module). */
    background: var(--treeohvox-bg, #1a1814);
    color: #f3e9c8;
  }
  .stripe {
    /* Same stripe convention as the other audio cards — colour replaced
       with TD-3 yellow to telegraph this is the 303-family voice. */
    height: 4px;
  }
  .tv-body {
    padding: 6px 10px 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .knob-row {
    display: flex;
    gap: 14px;
    align-items: flex-end;
    justify-content: space-between;
  }
</style>
