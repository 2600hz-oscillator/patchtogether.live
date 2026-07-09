<script lang="ts">
  // MOOG 904C — Voltage Controlled Filter Coupler card. Pairs a 904A-style
  // LOW-pass with a 904B-style HIGH-pass around one CUTOFF so the pair tracks
  // as a single voltage-controlled BAND-PASS (LP above the cutoff, HP below);
  // the MODE knob crossfades that to a band-REJECT (notch). Three knobs:
  // CUTOFF (band centre), WIDTH (LP/HP spread), MODE (band-pass ↔ notch).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog904a / Moog992 / CP3 cards.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog904cDef } from '$lib/audio/modules/moog904c';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog904cDef.params.find((p) => p.id === pid)!;
  }

  let cutoff = $derived(node?.params.cutoff ?? def('cutoff').defaultValue);
  let width = $derived(node?.params.width ?? def('width').defaultValue);
  let mode = $derived(node?.params.mode ?? def('mode').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // Audio in + CV cutoff input (left); single band-passed audio out.
  const inputs = portsFromDef(moog904cDef.inputs, { audio: 'IN', cutoff_cv: 'CUTOFF CV' });
  const outputs = portsFromDef(moog904cDef.outputs, { audio: 'OUT' });
</script>

<MoogPanel {id} {data} defaultLabel="904C Coupler" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Band centre + LP/HP spread + band-pass ↔ notch. -->
    <div class="knob-row" data-testid="moog904c-knobs">
      <Knob value={cutoff} min={def('cutoff').min} max={def('cutoff').max} defaultValue={def('cutoff').defaultValue} label="Cutoff" curve="log" onchange={setParam('cutoff')} moduleId={id} paramId="cutoff" readLive={readLive('cutoff')} />
      <Knob value={width} min={0} max={1} defaultValue={def('width').defaultValue} label="Width" curve="linear" onchange={setParam('width')} moduleId={id} paramId="width" readLive={readLive('width')} />
      <Knob value={mode} min={0} max={1} defaultValue={def('mode').defaultValue} label="Mode" curve="linear" onchange={setParam('mode')} moduleId={id} paramId="mode" readLive={readLive('mode')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 12px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
</style>
