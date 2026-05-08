<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

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

  // Voice column inputs sit in 4 vertical strips (left half of card).
  // FX-rack inputs hug the right edge above the master out handles.
  const VOICE_COL_W = 200;
  const TOP = 56;
  const ROW = 28;

  // y-stride of input handles down each voice column.
  function inY(slot: number): number {
    return TOP + slot * ROW;
  }

  // FX rack handles + outputs on the right edge.
  function fxY(slot: number): number {
    return TOP + slot * ROW;
  }
  // Outputs sit at the bottom-right of the card.
  const OUT_Y_L = 540;
  const OUT_Y_R = 564;
</script>

<div class="mod-card riotgirls-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">RIOTGIRLS</header>

  <!-- Voice columns: trig + gate + pitch input handles on the LEFT side,
       stacked per voice across 4 vertical strips. trigN and gateN are alternate
       names for the same underlying gate-input node — gateN exists so a
       Sequencer can patch its named "gate" output without a port-name mismatch. -->
  {#each [1, 2, 3, 4] as v (v)}
    <Handle type="target" position={Position.Left} id={`trig${v}`}  style="top: {inY(0)}px; --handle-color: var(--cable-gate);" />
    <Handle type="target" position={Position.Left} id={`gate${v}`}  style="top: {inY(1)}px; --handle-color: var(--cable-gate);" />
    <Handle type="target" position={Position.Left} id={`pitch${v}`} style="top: {inY(2)}px; --handle-color: var(--cable-cv);" />
  {/each}

  <!-- Outputs (right edge, bottom). -->
  <Handle type="source" position={Position.Right} id="outL" style="top: {OUT_Y_L}px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="outR" style="top: {OUT_Y_R}px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: {OUT_Y_L - 6}px;">outL</span>
  <span class="port-label right" style="top: {OUT_Y_R - 6}px;">outR</span>

  <!-- Voice strips + FX rack -->
  <div class="grid">
    {#each [1, 2, 3] as v (v)}
      <div class="voice-col">
        <div class="col-label">V{v} (DG)</div>
        <div class="port-stub">
          <span class="port-marker port-gate"></span><span class="port-text">trig</span>
        </div>
        <div class="port-stub">
          <span class="port-marker port-gate"></span><span class="port-text">gate</span>
        </div>
        <div class="port-stub">
          <span class="port-marker port-cv"></span><span class="port-text">pitch</span>
        </div>
        <Knob value={paramVal(`v${v}_pitch`,  0)}    min={-36}   max={36}  defaultValue={0}    label="PIT" curve="linear" onchange={set(`v${v}_pitch`)}  readLive={live(`v${v}_pitch`)} />
        <Knob value={paramVal(`v${v}_tone`,   0.3)}  min={0}     max={1}   defaultValue={0.3}  label="TON" curve="linear" onchange={set(`v${v}_tone`)}   readLive={live(`v${v}_tone`)} />
        <Knob value={paramVal(`v${v}_shape`,  0.3)}  min={0}     max={1}   defaultValue={0.3}  label="SHP" curve="linear" onchange={set(`v${v}_shape`)}  readLive={live(`v${v}_shape`)} />
        <Knob value={paramVal(`v${v}_decay`,  0.15)} min={0.001} max={0.5} defaultValue={0.15} label="DCY" curve="log"    onchange={set(`v${v}_decay`)}  readLive={live(`v${v}_decay`)} />
        <Knob value={paramVal(`v${v}_volume`, 1.0)}  min={0}     max={2.0} defaultValue={1.0}  label="VOL" curve="linear" onchange={set(`v${v}_volume`)} readLive={live(`v${v}_volume`)} />
        <Knob value={paramVal(`v${v}_pan`,    0)}    min={-1}    max={1}   defaultValue={0}    label="PAN" curve="linear" onchange={set(`v${v}_pan`)}    readLive={live(`v${v}_pan`)} />
        <div class="send-row">
          <Knob value={paramVal(`v${v}_sendA`, 0)} min={0} max={1} defaultValue={0} label="SDA" curve="linear" onchange={set(`v${v}_sendA`)} readLive={live(`v${v}_sendA`)} />
          <Knob value={paramVal(`v${v}_sendB`, 0)} min={0} max={1} defaultValue={0} label="SDB" curve="linear" onchange={set(`v${v}_sendB`)} readLive={live(`v${v}_sendB`)} />
        </div>
      </div>
    {/each}

    <!-- Voice 4: WT + ADSR + VCA -->
    <div class="voice-col">
      <div class="col-label">V4 (WT)</div>
      <div class="port-stub">
        <span class="port-marker port-gate"></span><span class="port-text">trig</span>
      </div>
      <div class="port-stub">
        <span class="port-marker port-gate"></span><span class="port-text">gate</span>
      </div>
      <div class="port-stub">
        <span class="port-marker port-cv"></span><span class="port-text">pitch</span>
      </div>
      <Knob value={paramVal('v4_tune',     0)}     min={-36}   max={36}  defaultValue={0}     label="TUN" curve="linear" onchange={set('v4_tune')}     readLive={live('v4_tune')} />
      <Knob value={paramVal('v4_wavePos',  0)}     min={0}     max={1}   defaultValue={0}     label="WAV" curve="linear" onchange={set('v4_wavePos')}  readLive={live('v4_wavePos')} />
      <Knob value={paramVal('v4_attack',   0.005)} min={0.001} max={2.0} defaultValue={0.005} label="ATK" curve="log"    onchange={set('v4_attack')}   readLive={live('v4_attack')} />
      <Knob value={paramVal('v4_decay',    0.1)}   min={0.001} max={4.0} defaultValue={0.1}   label="DCY" curve="log"    onchange={set('v4_decay')}    readLive={live('v4_decay')} />
      <Knob value={paramVal('v4_sustain',  0.7)}   min={0}     max={1}   defaultValue={0.7}   label="SUS" curve="linear" onchange={set('v4_sustain')}  readLive={live('v4_sustain')} />
      <Knob value={paramVal('v4_release',  0.3)}   min={0.001} max={8.0} defaultValue={0.3}   label="REL" curve="log"    onchange={set('v4_release')}  readLive={live('v4_release')} />
      <Knob value={paramVal('v4_volume',   0.8)}   min={0}     max={2.0} defaultValue={0.8}   label="VOL" curve="linear" onchange={set('v4_volume')}   readLive={live('v4_volume')} />
      <Knob value={paramVal('v4_pan',      0)}     min={-1}    max={1}   defaultValue={0}     label="PAN" curve="linear" onchange={set('v4_pan')}      readLive={live('v4_pan')} />
      <div class="send-row">
        <Knob value={paramVal('v4_sendA', 0)} min={0} max={1} defaultValue={0} label="SDA" curve="linear" onchange={set('v4_sendA')} readLive={live('v4_sendA')} />
        <Knob value={paramVal('v4_sendB', 0)} min={0} max={1} defaultValue={0} label="SDB" curve="linear" onchange={set('v4_sendB')} readLive={live('v4_sendB')} />
      </div>
    </div>

    <!-- FX rack column. WIP knobs (no audio in MVP-A) and the master QBRT
         filter (which IS wired). -->
    <div class="fx-col">
      <div class="col-label">FX <span class="wip">(WIP)</span></div>
      <div class="fx-section">
        <div class="fx-section-label">DESTROY</div>
        <Knob value={paramVal('bc_decimate', 1)}  min={1} max={64} defaultValue={1}  label="Dec"  curve="linear" onchange={set('bc_decimate')} readLive={live('bc_decimate')} />
        <Knob value={paramVal('bc_bits',     16)} min={1} max={16} defaultValue={16} label="Bits" curve="linear" onchange={set('bc_bits')}     readLive={live('bc_bits')} />
        <Knob value={paramVal('bc_wet',      1)}  min={0} max={1}  defaultValue={1}  label="Wet"  curve="linear" onchange={set('bc_wet')}      readLive={live('bc_wet')} />
      </div>
      <div class="fx-section">
        <div class="fx-section-label">REVERB</div>
        <Knob value={paramVal('rv_size', 0.5)} min={0} max={1} defaultValue={0.5} label="Size" curve="linear" onchange={set('rv_size')} readLive={live('rv_size')} />
        <Knob value={paramVal('rv_damp', 0.3)} min={0} max={1} defaultValue={0.3} label="Damp" curve="linear" onchange={set('rv_damp')} readLive={live('rv_damp')} />
        <Knob value={paramVal('rv_mix',  0.3)} min={0} max={1} defaultValue={0.3} label="Mix"  curve="linear" onchange={set('rv_mix')}  readLive={live('rv_mix')} />
      </div>
      <div class="fx-section">
        <div class="fx-section-label">RETURNS</div>
        <Knob value={paramVal('returnA', 0.5)} min={0} max={1} defaultValue={0.5} label="retA" curve="linear" onchange={set('returnA')} readLive={live('returnA')} />
        <Knob value={paramVal('returnB', 0.5)} min={0} max={1} defaultValue={0.5} label="retB" curve="linear" onchange={set('returnB')} readLive={live('returnB')} />
      </div>
      <div class="fx-section master-section">
        <div class="fx-section-label">QBRT (MASTER)</div>
        <Knob value={paramVal('flt_cutoff',    18000)} min={20}    max={20000} defaultValue={18000} label="Cut"  curve="log"    onchange={set('flt_cutoff')}    readLive={live('flt_cutoff')} />
        <Knob value={paramVal('flt_resonance', 0.4)}   min={0}     max={0.99}  defaultValue={0.4}   label="Res"  curve="linear" onchange={set('flt_resonance')} readLive={live('flt_resonance')} />
        <Knob value={paramVal('flt_mode',      0)}     min={0}     max={1}     defaultValue={0}     label="Mode" curve="linear" onchange={set('flt_mode')}      readLive={live('flt_mode')} />
        <Knob value={paramVal('flt_pingDecay', 0.15)}  min={0.005} max={0.5}   defaultValue={0.15}  label="Ping" curve="log"    onchange={set('flt_pingDecay')} readLive={live('flt_pingDecay')} />
      </div>
    </div>
  </div>
</div>

<style>
  .riotgirls-card {
    width: 1100px;
    min-height: 600px;
  }
  .grid {
    margin-top: 28px;
    display: grid;
    grid-template-columns: repeat(4, 200px) 1fr;
    gap: 8px;
    padding: 0 16px 0 40px;
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
  .port-stub {
    display: flex;
    gap: 4px;
    align-items: center;
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .port-marker {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .port-marker.port-gate { background: var(--cable-gate); }
  .port-marker.port-cv   { background: var(--cable-cv); }
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
