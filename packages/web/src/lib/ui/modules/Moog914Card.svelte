<script lang="ts">
  // MOOG 914 EXTENDED FIXED FILTER BANK card — the System 55's full fixed
  // filter bank (twelve bands). A single audio input, a single audio output,
  // and a VERTICAL COLUMN of small level knobs: HP at the top, then the twelve
  // fixed bandpass bands (low→high), then LP at the bottom — the graphic-EQ-
  // like faceplate.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as MoogCp3MixerCard / Moog992Card. The band list is derived from the same
  // shared center table the def + factory use, so the card stays in lock-step;
  // 914 vs 907A differ only in how many bands the table yields.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog914Def } from '$lib/audio/modules/moog914';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog914Def.params.find((p) => p.id === pid)!;
  }

  // The full ordered param list (hp, band1..band12, lp) straight from the def —
  // so this card automatically matches whatever the shared lib's center table
  // yields. Each entry tracks its live param value reactively.
  const paramDefs = moog914Def.params;
  let values = $derived(
    Object.fromEntries(
      paramDefs.map((p) => [p.id, node?.params[p.id] ?? p.defaultValue]),
    ) as Record<string, number>,
  );

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

  const inputs = portsFromDef(moog914Def.inputs, { audio: 'IN' });
  const outputs = portsFromDef(moog914Def.outputs, { audio: 'OUT' });
</script>

<MoogPanel {id} {data} defaultLabel="914 Filter Bank" width={200}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Vertical column of small band-level knobs: HP, band1..12, LP. -->
    <div class="band-column" data-testid="moog914-bands">
      {#each paramDefs as p (p.id)}
        <Knob
          value={values[p.id]}
          min={p.min}
          max={p.max}
          defaultValue={def(p.id).defaultValue}
          label={p.label}
          curve="linear"
          onchange={setParam(p.id)}
          moduleId={id}
          paramId={p.id}
          readLive={readLive(p.id)}
        />
      {/each}
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .band-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 18px 4px;
    align-items: center;
  }
</style>
