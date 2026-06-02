<script lang="ts">
  // MOOG 911 ENVELOPE GENERATOR card — the Moog System 55/35 contour
  // generator's faceplate (Fig 17). Four knobs: T1 (attack), T2 (initial
  // decay), ESUS (sustain level), T3 (final decay); a TRIGGER input jack;
  // and the OUTPUT (envelope CV) + inverted-output jacks in the patch panel.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // reuse contract the 921 VCO card follows.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog911Def } from '$lib/audio/modules/moog911';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog911Def.params.find((p) => p.id === pid)!;
  }

  let t1   = $derived(node?.params.t1   ?? def('t1').defaultValue);
  let t2   = $derived(node?.params.t2   ?? def('t2').defaultValue);
  let esus = $derived(node?.params.esus ?? def('esus').defaultValue);
  let t3   = $derived(node?.params.t3   ?? def('t3').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  const inputs: PortDescriptor[] = [
    { id: 'gate',    label: 'TRIG', cable: 'gate' },
    { id: 't1_cv',   label: 'T1',   cable: 'cv' },
    { id: 't2_cv',   label: 'T2',   cable: 'cv' },
    { id: 'esus_cv', label: 'ESUS', cable: 'cv' },
    { id: 't3_cv',   label: 'T3',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'env',     label: 'OUT', cable: 'cv' },
    { id: 'env_inv', label: 'INV', cable: 'cv' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="Moog 911 EG" width={232}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Contour controls: T1 (attack) + T2 (initial decay). -->
    <div class="knob-row" data-testid="moog911-time-row">
      <Knob value={t1} min={0.0001} max={10} defaultValue={0.01} label="T1" units="s" curve="log" onchange={setParam('t1')} moduleId={id} paramId="t1" readLive={readLive('t1')} />
      <Knob value={t2} min={0.0001} max={10} defaultValue={0.2} label="T2" units="s" curve="log" onchange={setParam('t2')} moduleId={id} paramId="t2" readLive={readLive('t2')} />
    </div>

    <!-- ESUS (sustain level) + T3 (final decay). -->
    <div class="knob-row">
      <Knob value={esus} min={0} max={1} defaultValue={0.6} label="Esus" curve="linear" onchange={setParam('esus')} moduleId={id} paramId="esus" readLive={readLive('esus')} />
      <Knob value={t3} min={0.0001} max={10} defaultValue={0.4} label="T3" units="s" curve="log" onchange={setParam('t3')} moduleId={id} paramId="t3" readLive={readLive('t3')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 14px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
</style>
