<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function paramVal(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // The card exposes a handle for every input port in the riotgirls module def
  // (55 inputs + 2 outputs). Voice handles + FX rack handles + outputs are
  // organized into the patch panel's 'sectioned' layout so the user can scan
  // by voice (V1/V2/V3/V4) + master FX block.

  type VoicePort = { id: string; label: string; cable: string };
  const VOICE_PORTS_DG = (v: 1 | 2 | 3): VoicePort[] => [
    { id: `trig${v}`,     label: `V${v} TRIGGER`, cable: 'gate' },
    { id: `gate${v}`,     label: `V${v} GATE`,    cable: 'gate' },
    { id: `pitch${v}`,    label: `V${v} PITCH`,   cable: 'cv' },
    { id: `v${v}_tone`,   label: `V${v} TONE`,    cable: 'cv' },
    { id: `v${v}_shape`,  label: `V${v} SHAPE`,   cable: 'cv' },
    { id: `v${v}_volume`, label: `V${v} VOLUME`,  cable: 'cv' },
    { id: `v${v}_decay`,  label: `V${v} DECAY`,   cable: 'cv' },
    { id: `v${v}_pan`,    label: `V${v} PAN`,     cable: 'cv' },
    { id: `v${v}_sendA`,  label: `V${v} SEND A`,  cable: 'cv' },
    { id: `v${v}_sendB`,  label: `V${v} SEND B`,  cable: 'cv' },
  ];
  const VOICE_PORTS_V4: VoicePort[] = [
    { id: 'trig4',      label: 'V4 TRIGGER',     cable: 'gate' },
    { id: 'gate4',      label: 'V4 GATE',        cable: 'gate' },
    { id: 'pitch4',     label: 'V4 PITCH',       cable: 'cv' },
    { id: 'v4_fm',      label: 'V4 FM',          cable: 'audio' },
    { id: 'v4_wavePos', label: 'V4 WAVE POS',    cable: 'cv' },
    { id: 'v4_attack',  label: 'V4 ATTACK',      cable: 'cv' },
    { id: 'v4_decay',   label: 'V4 DECAY',       cable: 'cv' },
    { id: 'v4_sustain', label: 'V4 SUSTAIN',     cable: 'cv' },
    { id: 'v4_release', label: 'V4 RELEASE',     cable: 'cv' },
    { id: 'v4_volume',  label: 'V4 VOLUME',      cable: 'cv' },
    { id: 'v4_pan',     label: 'V4 PAN',         cable: 'cv' },
    { id: 'v4_sendA',   label: 'V4 SEND A',      cable: 'cv' },
    { id: 'v4_sendB',   label: 'V4 SEND B',      cable: 'cv' },
  ];

  const FX_PORTS: PortDescriptor[] = [
    { id: 'bc_decimate',   label: 'DESTROY DECIMATE', cable: 'cv' },
    { id: 'bc_bits',       label: 'DESTROY BITS',     cable: 'cv' },
    { id: 'bc_wet',        label: 'DESTROY WET',      cable: 'cv' },
    { id: 'rv_size',       label: 'REVERB SIZE',      cable: 'cv' },
    { id: 'rv_damp',       label: 'REVERB DAMP',      cable: 'cv' },
    { id: 'rv_mix',        label: 'REVERB MIX',       cable: 'cv' },
    { id: 'flt_cutoff',    label: 'FILTER CUTOFF',    cable: 'cv' },
    { id: 'flt_resonance', label: 'FILTER RESONANCE', cable: 'cv' },
    { id: 'flt_mode',      label: 'FILTER MODE',      cable: 'cv' },
    { id: 'flt_pingDecay', label: 'FILTER PING DECAY', cable: 'cv' },
    { id: 'returnA',       label: 'RETURN A',         cable: 'audio' },
    { id: 'returnB',       label: 'RETURN B',         cable: 'audio' },
  ];

  const sections = [
    { label: 'Voice 1 (DG)', inputs: VOICE_PORTS_DG(1) },
    { label: 'Voice 2 (DG)', inputs: VOICE_PORTS_DG(2) },
    { label: 'Voice 3 (DG)', inputs: VOICE_PORTS_DG(3) },
    { label: 'Voice 4 (WT)', inputs: VOICE_PORTS_V4 },
    {
      label: 'Master FX',
      inputs: FX_PORTS,
      outputs: [
        { id: 'outL', label: 'OUT L', cable: 'audio' },
        { id: 'outR', label: 'OUT R', cable: 'audio' },
      ] as PortDescriptor[],
    },
  ];
</script>

<div class="mod-card riotgirls-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="RIOTGIRLS" />

  <!--
    panelWidth is the total open-state popover width. RIOTGIRLS has
    55 inputs + 2 outputs across 5 sections (V1/V2/V3/V4/Master FX);
    600 gives the inputs column ~290px — wide enough for verbose
    labels like "FILTER PING DECAY". The inputs column scrolls
    independently when content overflows, so the panel never grows
    taller than 70vh.
  -->
  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={600}>
    <!-- Knob grid (unchanged from MVP-A) — voice strips + FX rack. -->
    <div class="grid">
      {#each [1, 2, 3] as v (v)}
        <div class="voice-col">
          <div class="col-label">V{v} (DG)</div>
          <Knob value={paramVal(`v${v}_pitch`,  0)}    min={-36}   max={36}  defaultValue={0}    label="PIT" curve="linear" onchange={set(`v${v}_pitch`)} moduleId={id} paramId={`v${v}_pitch`}  readLive={live(`v${v}_pitch`)} />
          <Knob value={paramVal(`v${v}_tone`,   0.3)}  min={0}     max={1}   defaultValue={0.3}  label="TON" curve="linear" onchange={set(`v${v}_tone`)} moduleId={id} paramId={`v${v}_tone`}   readLive={live(`v${v}_tone`)} />
          <Knob value={paramVal(`v${v}_shape`,  0.3)}  min={0}     max={1}   defaultValue={0.3}  label="SHP" curve="linear" onchange={set(`v${v}_shape`)} moduleId={id} paramId={`v${v}_shape`}  readLive={live(`v${v}_shape`)} />
          <Knob value={paramVal(`v${v}_decay`,  0.15)} min={0.001} max={0.5} defaultValue={0.15} label="DCY" curve="log"    onchange={set(`v${v}_decay`)} moduleId={id} paramId={`v${v}_decay`}  readLive={live(`v${v}_decay`)} />
          <Knob value={paramVal(`v${v}_volume`, 1.0)}  min={0}     max={2.0} defaultValue={1.0}  label="VOL" curve="linear" onchange={set(`v${v}_volume`)} moduleId={id} paramId={`v${v}_volume`} readLive={live(`v${v}_volume`)} />
          <Knob value={paramVal(`v${v}_pan`,    0)}    min={-1}    max={1}   defaultValue={0}    label="PAN" curve="linear" onchange={set(`v${v}_pan`)} moduleId={id} paramId={`v${v}_pan`}    readLive={live(`v${v}_pan`)} />
          <div class="send-row">
            <Knob value={paramVal(`v${v}_sendA`, 0)} min={0} max={1} defaultValue={0} label="SDA" curve="linear" onchange={set(`v${v}_sendA`)} moduleId={id} paramId={`v${v}_sendA`} readLive={live(`v${v}_sendA`)} />
            <Knob value={paramVal(`v${v}_sendB`, 0)} min={0} max={1} defaultValue={0} label="SDB" curve="linear" onchange={set(`v${v}_sendB`)} moduleId={id} paramId={`v${v}_sendB`} readLive={live(`v${v}_sendB`)} />
          </div>
        </div>
      {/each}

      <!-- Voice 4: WT + ADSR + VCA -->
      <div class="voice-col">
        <div class="col-label">V4 (WT)</div>
        <Knob value={paramVal('v4_tune',     0)}     min={-36}   max={36}  defaultValue={0}     label="TUN" curve="linear" onchange={set('v4_tune')} moduleId={id} paramId="v4_tune"     readLive={live('v4_tune')} />
        <Knob value={paramVal('v4_wavePos',  0)}     min={0}     max={1}   defaultValue={0}     label="WAV" curve="linear" onchange={set('v4_wavePos')} moduleId={id} paramId="v4_wavePos"  readLive={live('v4_wavePos')} />
        <Knob value={paramVal('v4_attack',   0.005)} min={0.001} max={2.0} defaultValue={0.005} label="ATK" curve="log"    onchange={set('v4_attack')} moduleId={id} paramId="v4_attack"   readLive={live('v4_attack')} />
        <Knob value={paramVal('v4_decay',    0.1)}   min={0.001} max={4.0} defaultValue={0.1}   label="DCY" curve="log"    onchange={set('v4_decay')} moduleId={id} paramId="v4_decay"    readLive={live('v4_decay')} />
        <Knob value={paramVal('v4_sustain',  0.7)}   min={0}     max={1}   defaultValue={0.7}   label="SUS" curve="linear" onchange={set('v4_sustain')} moduleId={id} paramId="v4_sustain"  readLive={live('v4_sustain')} />
        <Knob value={paramVal('v4_release',  0.3)}   min={0.001} max={8.0} defaultValue={0.3}   label="REL" curve="log"    onchange={set('v4_release')} moduleId={id} paramId="v4_release"  readLive={live('v4_release')} />
        <Knob value={paramVal('v4_volume',   0.8)}   min={0}     max={2.0} defaultValue={0.8}   label="VOL" curve="linear" onchange={set('v4_volume')} moduleId={id} paramId="v4_volume"   readLive={live('v4_volume')} />
        <Knob value={paramVal('v4_pan',      0)}     min={-1}    max={1}   defaultValue={0}     label="PAN" curve="linear" onchange={set('v4_pan')} moduleId={id} paramId="v4_pan"      readLive={live('v4_pan')} />
        <div class="send-row">
          <Knob value={paramVal('v4_sendA', 0)} min={0} max={1} defaultValue={0} label="SDA" curve="linear" onchange={set('v4_sendA')} moduleId={id} paramId="v4_sendA" readLive={live('v4_sendA')} />
          <Knob value={paramVal('v4_sendB', 0)} min={0} max={1} defaultValue={0} label="SDB" curve="linear" onchange={set('v4_sendB')} moduleId={id} paramId="v4_sendB" readLive={live('v4_sendB')} />
        </div>
      </div>

      <!-- FX rack column. -->
      <div class="fx-col">
        <div class="col-label">FX <span class="wip">(WIP)</span></div>
        <div class="fx-section">
          <div class="fx-section-label">DESTROY</div>
          <Knob value={paramVal('bc_decimate', 1)}  min={1} max={64} defaultValue={1}  label="Dec"  curve="linear" onchange={set('bc_decimate')} moduleId={id} paramId="bc_decimate" readLive={live('bc_decimate')} />
          <Knob value={paramVal('bc_bits',     16)} min={1} max={16} defaultValue={16} label="Bits" curve="linear" onchange={set('bc_bits')} moduleId={id} paramId="bc_bits"     readLive={live('bc_bits')} />
          <Knob value={paramVal('bc_wet',      1)}  min={0} max={1}  defaultValue={1}  label="Wet"  curve="linear" onchange={set('bc_wet')} moduleId={id} paramId="bc_wet"      readLive={live('bc_wet')} />
        </div>
        <div class="fx-section">
          <div class="fx-section-label">REVERB</div>
          <Knob value={paramVal('rv_size', 0.5)} min={0} max={1} defaultValue={0.5} label="Size" curve="linear" onchange={set('rv_size')} moduleId={id} paramId="rv_size" readLive={live('rv_size')} />
          <Knob value={paramVal('rv_damp', 0.3)} min={0} max={1} defaultValue={0.3} label="Damp" curve="linear" onchange={set('rv_damp')} moduleId={id} paramId="rv_damp" readLive={live('rv_damp')} />
          <Knob value={paramVal('rv_mix',  0.3)} min={0} max={1} defaultValue={0.3} label="Mix"  curve="linear" onchange={set('rv_mix')} moduleId={id} paramId="rv_mix"  readLive={live('rv_mix')} />
        </div>
        <div class="fx-section">
          <div class="fx-section-label">RETURNS</div>
          <Knob value={paramVal('returnA', 0.5)} min={0} max={1} defaultValue={0.5} label="retA" curve="linear" onchange={set('returnA')} moduleId={id} paramId="returnA" readLive={live('returnA')} />
          <Knob value={paramVal('returnB', 0.5)} min={0} max={1} defaultValue={0.5} label="retB" curve="linear" onchange={set('returnB')} moduleId={id} paramId="returnB" readLive={live('returnB')} />
        </div>
        <div class="fx-section master-section">
          <div class="fx-section-label">QBRT (MASTER)</div>
          <Knob value={paramVal('flt_cutoff',    18000)} min={20}    max={20000} defaultValue={18000} label="Cut"  curve="log"    onchange={set('flt_cutoff')} moduleId={id} paramId="flt_cutoff"    readLive={live('flt_cutoff')} />
          <Knob value={paramVal('flt_resonance', 0.4)}   min={0}     max={0.99}  defaultValue={0.4}   label="Res"  curve="linear" onchange={set('flt_resonance')} moduleId={id} paramId="flt_resonance" readLive={live('flt_resonance')} />
          <Knob value={paramVal('flt_mode',      0)}     min={0}     max={1}     defaultValue={0}     label="Mode" curve="linear" onchange={set('flt_mode')} moduleId={id} paramId="flt_mode"      readLive={live('flt_mode')} />
          <Knob value={paramVal('flt_pingDecay', 0.15)}  min={0.005} max={0.5}   defaultValue={0.15}  label="Ping" curve="log"    onchange={set('flt_pingDecay')} moduleId={id} paramId="flt_pingDecay" readLive={live('flt_pingDecay')} />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .riotgirls-card {
    width: 1100px;
    min-height: 760px;
  }
  .grid {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(4, 200px) 1fr;
    gap: 8px;
    padding: 0 22px;
  }
  .voice-col,
  .fx-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .fx-col {
    border-left: 1px solid #2a2f3a;
    padding-left: 12px;
    align-items: stretch;
  }
  .col-label {
    font-size: 0.65rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .wip {
    color: var(--accent-dim, #607080);
    opacity: 0.7;
  }
  .send-row {
    display: flex;
    gap: 6px;
  }
  .fx-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border: 1px dashed #2a2f3a;
    border-radius: 2px;
  }
  .fx-section.master-section {
    border-style: solid;
    border-color: #404652;
  }
  .fx-section-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>
