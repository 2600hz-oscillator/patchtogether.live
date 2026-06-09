<script lang="ts">
  // SampleHoldCard — SAMPLE & HOLD / quantizer.
  //
  // Layout:
  //         "Major"          ← the scale NAME, shown ABOVE the knob
  //        ◐ SCALE           ← the SCALE knob (cycles the quantize scale)
  //
  //   Patch panel:
  //     inputs:  CV, GATE
  //     outputs: HOLD (cv_out), QUANT (cv_quant)
  //
  // The scale-name label is the headline UX feature — it updates reactively
  // as the SCALE knob (or its CV / MIDI Learn target) changes.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    sampleHoldDef,
    SAMPLE_HOLD_SCALE_NAMES,
    SAMPLE_HOLD_MAX_SCALE,
    sampleHoldScaleName,
  } from '$lib/audio/modules/sample-hold';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    sampleHoldDef.params.find((p) => p.id === pid)!.defaultValue;

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

  // The scale-name label — tracks the live `scale` param (user / CV / MIDI).
  let scaleNameStr = $derived(sampleHoldScaleName(paramVal('scale')));

  // Quantizer-vs-S&H hint: when gate_in is patched, the module is a sample &
  // hold; unpatched, it's a continuous quantizer. Mirror the factory's
  // graph-level check so the card hints the active mode.
  let gatePatched = $derived(
    Object.values(patch.edges).some(
      (e) => e && e.target.nodeId === id && e.target.portId === 'gate_in',
    ),
  );
  let modeHint = $derived(gatePatched ? 'S&H' : 'QUANTIZER');

  const inputs: PortDescriptor[] = [
    { id: 'cv_in',   label: 'CV',   cable: 'cv' },
    { id: 'gate_in', label: 'GATE', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'cv_out',   label: 'HOLD',  cable: 'cv' },
    { id: 'cv_quant', label: 'QUANT', cable: 'cv' },
  ];
</script>

<div class="mod-card samplehold-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="SAMPLE & HOLD" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={260}>
    <div class="sh-body">
      <div class="scale-group" data-testid="samplehold-scale-group">
        <div class="scale-name" data-testid="samplehold-scale-name">{scaleNameStr}</div>
        <Knob
          value={paramVal('scale')}
          min={0}
          max={SAMPLE_HOLD_MAX_SCALE}
          defaultValue={defaultFor('scale')}
          label="Scale"
          curve="discrete"
          onchange={set('scale')}
          moduleId={id}
          paramId="scale"
          readLive={live('scale')}
        />
        <div class="mode-hint" data-testid="samplehold-mode-hint">{modeHint}</div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .samplehold-card {
    width: 260px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .samplehold-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .samplehold-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .sh-body { padding: 6px 10px 4px; display: flex; justify-content: center; }
  .scale-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 92px;
  }
  /* The scale NAME sits ABOVE the knob (spec requirement). */
  .scale-name {
    font-family: var(--font-mono, monospace);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--accent, #ffce6e);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .mode-hint {
    font-family: var(--font-mono, monospace);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    color: var(--text-dim, #8a8a8a);
    text-align: center;
  }
</style>
