<script lang="ts">
  // WarpsCard — Mutable Instruments Warps meta-modulator.
  //
  // Discrete algorithm selector (XFADE / RING-MOD / XOR / COMPARE) plus
  // five continuous knobs: SHAPE (internal carrier waveform), TIMBRE
  // (algorithm intensity), LEVEL 1 (carrier gain), LEVEL 2 (modulator
  // gain), NOTE (semitone offset). PITCH input is V/oct for the internal
  // carrier oscillator.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { warpsDef, WARPS_MAX_ALGORITHM, WARPS_ALGORITHM_NAMES } from '$lib/audio/modules/warps';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (id: string): number =>
    warpsDef.params.find((p) => p.id === id)!.defaultValue;

  let algorithm    = $derived(node?.params.algorithm     ?? defaultFor('algorithm'));
  let carrierShape = $derived(node?.params.carrier_shape ?? defaultFor('carrier_shape'));
  let timbre       = $derived(node?.params.timbre        ?? defaultFor('timbre'));
  let level1       = $derived(node?.params.level_1       ?? defaultFor('level_1'));
  let level2       = $derived(node?.params.level_2       ?? defaultFor('level_2'));
  let note         = $derived(node?.params.note          ?? defaultFor('note'));

  let algoLabel = $derived(
    WARPS_ALGORITHM_NAMES[Math.max(0, Math.min(WARPS_ALGORITHM_NAMES.length - 1, Math.round(algorithm)))],
  );

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'carrier_in',       cable: 'audio' },
    { id: 'modulator_in',     cable: 'audio' },
    { id: 'pitch',            cable: 'pitch' },
    { id: 'algorithm_cv',     cable: 'cv' },
    { id: 'carrier_shape_cv', cable: 'cv' },
    { id: 'timbre_cv',        cable: 'cv' },
    { id: 'level_1_cv',       cable: 'cv' },
    { id: 'level_2_cv',       cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'audio' },
  ];
</script>

<div class="mod-card warps-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">WARPS</header>
  <div class="algo-readout" data-testid="warps-algo-name">{algoLabel}</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={algorithm}    min={0}   max={WARPS_MAX_ALGORITHM} defaultValue={0}   label="Algo"   curve="discrete" onchange={set('algorithm')} moduleId={id} paramId="algorithm"     readLive={live('algorithm')} />
      <Fader value={carrierShape} min={0}   max={1}  defaultValue={0}   label="Shape"  curve="linear" onchange={set('carrier_shape')} moduleId={id} paramId="carrier_shape" readLive={live('carrier_shape')} />
      <Fader value={timbre}       min={0}   max={1}  defaultValue={0.5} label="Timbre" curve="linear" onchange={set('timbre')} moduleId={id} paramId="timbre"        readLive={live('timbre')} />
      <Fader value={level1}       min={0}   max={1}  defaultValue={1.0} label="Lvl 1"  curve="linear" onchange={set('level_1')} moduleId={id} paramId="level_1"       readLive={live('level_1')} />
      <Fader value={level2}       min={0}   max={1}  defaultValue={1.0} label="Lvl 2"  curve="linear" onchange={set('level_2')} moduleId={id} paramId="level_2"       readLive={live('level_2')} />
      <Fader value={note}         min={-60} max={60} defaultValue={0}   label="Note"   units="st" curve="linear" onchange={set('note')} moduleId={id} paramId="note" readLive={live('note')} />
    </div>
  </PatchPanel>
  <OssAttribution author={warpsDef.ossAttribution?.author} />
</div>

<style>
  .warps-card { width: 320px; min-height: 240px; }
  .warps-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  /* Algorithm readout — same pattern as MACROOSCILLATOR's model strip. */
  .warps-card .algo-readout {
    text-align: center;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--text-muted, #999);
    margin-top: -2px;
    margin-bottom: 2px;
  }
  .warps-card .fader-row {
    margin-top: 10px;
    display: flex;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
  }
</style>
