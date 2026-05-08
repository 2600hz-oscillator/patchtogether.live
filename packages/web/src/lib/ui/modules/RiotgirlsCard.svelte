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

  // ---- Handle layout ----
  // The card exposes a handle for every input port in the riotgirls module def
  // (55 inputs + 2 outputs). Voice handles stack down the LEFT edge in 4
  // sections (V1, V2, V3, V4). FX-rack handles stack down the RIGHT edge above
  // the master output handles.
  //
  // The sections are sized so the longest voice (V4 — 13 ports) fits, with the
  // 3 shorter voices (V1-V3 — 10 ports each) padded with empty rows so each
  // section starts at a predictable y-offset. This keeps the section labels
  // aligned with the rest of the card's vertical rhythm.

  const ROW = 18;             // y-stride between handles
  const SECTION_GAP = 14;     // extra gap between voice sections
  const TOP = 56;             // first handle's y-offset

  // Per-voice port slots — V1-V3 = 10, V4 = 13. We pad V1-V3 to 13 so all
  // four voices align to the same section height (simpler math, also leaves
  // room for future per-voice CV additions).
  const PER_VOICE_SLOTS = 13;
  const SECTION_HEIGHT = PER_VOICE_SLOTS * ROW + SECTION_GAP;

  // y-offset for the n-th port within voice v (0-indexed v).
  function voiceY(v: number, slot: number): number {
    return TOP + v * SECTION_HEIGHT + slot * ROW;
  }

  // FX rack stacks down the right edge — 12 master CV handles, then 2 outputs.
  function fxY(slot: number): number {
    return TOP + slot * ROW;
  }

  // Outputs sit directly under the FX stack on the right.
  const FX_SLOT_COUNT = 12;
  const OUT_Y_L = TOP + (FX_SLOT_COUNT + 2) * ROW;
  const OUT_Y_R = OUT_Y_L + ROW;

  // Voice descriptors — each voice declares the ordered list of input ports
  // displayed on the LEFT edge. v1-v3 share the DRUMMERGIRL surface; v4 has
  // its WT+ADSR+VCA-specific set. The label is rendered next to the handle.
  type VoicePort = { id: string; label: string; cable: string };
  const VOICE_PORTS_DG = (v: 1 | 2 | 3): VoicePort[] => [
    { id: `trig${v}`,     label: 'TRG', cable: 'var(--cable-gate)' },
    { id: `gate${v}`,     label: 'GAT', cable: 'var(--cable-gate)' },
    { id: `pitch${v}`,    label: 'PIT', cable: 'var(--cable-cv)' },
    { id: `v${v}_tone`,   label: 'TON', cable: 'var(--cable-cv)' },
    { id: `v${v}_shape`,  label: 'SHP', cable: 'var(--cable-cv)' },
    { id: `v${v}_volume`, label: 'VOL', cable: 'var(--cable-cv)' },
    { id: `v${v}_decay`,  label: 'DCY', cable: 'var(--cable-cv)' },
    { id: `v${v}_pan`,    label: 'PAN', cable: 'var(--cable-cv)' },
    { id: `v${v}_sendA`,  label: 'SDA', cable: 'var(--cable-cv)' },
    { id: `v${v}_sendB`,  label: 'SDB', cable: 'var(--cable-cv)' },
  ];
  const VOICE_PORTS_V4: VoicePort[] = [
    { id: 'trig4',      label: 'TRG', cable: 'var(--cable-gate)' },
    { id: 'gate4',      label: 'GAT', cable: 'var(--cable-gate)' },
    { id: 'pitch4',     label: 'PIT', cable: 'var(--cable-cv)' },
    { id: 'v4_fm',      label: 'FM',  cable: 'var(--cable-audio)' },
    { id: 'v4_wavePos', label: 'WAV', cable: 'var(--cable-cv)' },
    { id: 'v4_attack',  label: 'ATK', cable: 'var(--cable-cv)' },
    { id: 'v4_decay',   label: 'DCY', cable: 'var(--cable-cv)' },
    { id: 'v4_sustain', label: 'SUS', cable: 'var(--cable-cv)' },
    { id: 'v4_release', label: 'REL', cable: 'var(--cable-cv)' },
    { id: 'v4_volume',  label: 'VOL', cable: 'var(--cable-cv)' },
    { id: 'v4_pan',     label: 'PAN', cable: 'var(--cable-cv)' },
    { id: 'v4_sendA',   label: 'SDA', cable: 'var(--cable-cv)' },
    { id: 'v4_sendB',   label: 'SDB', cable: 'var(--cable-cv)' },
  ];

  const VOICE_SECTIONS: { label: string; ports: VoicePort[] }[] = [
    { label: 'V1 (DG)', ports: VOICE_PORTS_DG(1) },
    { label: 'V2 (DG)', ports: VOICE_PORTS_DG(2) },
    { label: 'V3 (DG)', ports: VOICE_PORTS_DG(3) },
    { label: 'V4 (WT)', ports: VOICE_PORTS_V4 },
  ];

  // Master FX strip on the right edge.
  type FxPort = { id: string; label: string };
  const FX_PORTS: FxPort[] = [
    { id: 'bc_decimate',   label: 'DEC' },
    { id: 'bc_bits',       label: 'BIT' },
    { id: 'bc_wet',        label: 'WET' },
    { id: 'rv_size',       label: 'SIZ' },
    { id: 'rv_damp',       label: 'DMP' },
    { id: 'rv_mix',        label: 'MIX' },
    { id: 'flt_cutoff',    label: 'CUT' },
    { id: 'flt_resonance', label: 'RES' },
    { id: 'flt_mode',      label: 'MOD' },
    { id: 'flt_pingDecay', label: 'PNG' },
    { id: 'returnA',       label: 'RTA' },
    { id: 'returnB',       label: 'RTB' },
  ];

  // Card height auto-derives from the longest of the two strips. With 4 voice
  // sections × 13 slots × 18 px/row + section gaps + bottom padding, the card
  // is ~1000 px tall.
  const CARD_HEIGHT = TOP + 4 * SECTION_HEIGHT + 40;
</script>

<div class="mod-card riotgirls-card" style="min-height: {CARD_HEIGHT}px;">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">RIOTGIRLS</header>

  <!-- LEFT-edge handles: 4 voice sections, top-to-bottom.
       Each port renders a Handle + a port-label + a section-divider header. -->
  {#each VOICE_SECTIONS as section, vIdx (section.label)}
    <div class="section-header" style="top: {voiceY(vIdx, 0) - 16}px;">{section.label}</div>
    {#each section.ports as port, slot (port.id)}
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        style="top: {voiceY(vIdx, slot)}px; --handle-color: {port.cable};"
      />
      <span class="port-label left" style="top: {voiceY(vIdx, slot) - 6}px;">{port.label}</span>
    {/each}
  {/each}

  <!-- RIGHT-edge handles: master FX strip + outputs. -->
  <div class="section-header right" style="top: {fxY(0) - 16}px;">MASTER</div>
  {#each FX_PORTS as port, slot (port.id)}
    <Handle
      type="target"
      position={Position.Right}
      id={port.id}
      style="top: {fxY(slot)}px; --handle-color: var(--cable-cv);"
    />
    <span class="port-label right" style="top: {fxY(slot) - 6}px;">{port.label}</span>
  {/each}

  <!-- Outputs (right edge, below the FX stack). -->
  <Handle type="source" position={Position.Right} id="outL" style="top: {OUT_Y_L}px; --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="outR" style="top: {OUT_Y_R}px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: {OUT_Y_L - 6}px;">outL</span>
  <span class="port-label right" style="top: {OUT_Y_R - 6}px;">outR</span>

  <!-- Knob grid (unchanged from MVP-A) — voice strips + FX rack. -->
  <div class="grid">
    {#each [1, 2, 3] as v (v)}
      <div class="voice-col">
        <div class="col-label">V{v} (DG)</div>
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

    <!-- FX rack column. -->
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
  }
  .grid {
    margin-top: 28px;
    display: grid;
    grid-template-columns: repeat(4, 200px) 1fr;
    gap: 8px;
    padding: 0 80px 0 60px;
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
  /* Section dividers for the LEFT/RIGHT edge handle stacks. */
  .section-header {
    position: absolute;
    left: 6px;
    font-size: 0.55rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .section-header.right {
    left: auto;
    right: 6px;
  }
</style>
