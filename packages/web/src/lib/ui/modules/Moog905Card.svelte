<script lang="ts">
  // MOOG 905 SPRING REVERBERATION card — the classic Moog spring-reverb tank
  // of the Moog System 55 / 35 clone family. One audio input, one audio
  // output, three knobs: MIX (dry↔wet), DECAY (tail length / feedback), SIZE
  // (spring length / dispersion + chirp character).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as Moog992Card / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog905Def } from '$lib/audio/modules/moog905';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog905Def.params.find((p) => p.id === pid)!;
  }

  let mix = $derived(node?.params.mix ?? def('mix').defaultValue);
  let decay = $derived(node?.params.decay ?? def('decay').defaultValue);
  let size = $derived(node?.params.size ?? def('size').defaultValue);

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

  // One audio input (left); one audio output (right).
  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'IN', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio', label: 'OUT', cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="moogafakkin 905 Spring Reverb" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- MIX (dry↔wet), DECAY (tail), SIZE (spring length / chirp). -->
    <div class="knob-row" data-testid="moog905-knobs">
      <Knob value={mix} min={0} max={1} defaultValue={def('mix').defaultValue} label="Mix" curve="linear" onchange={setParam('mix')} moduleId={id} paramId="mix" readLive={readLive('mix')} />
      <Knob value={decay} min={0} max={1} defaultValue={def('decay').defaultValue} label="Decay" curve="linear" onchange={setParam('decay')} moduleId={id} paramId="decay" readLive={readLive('decay')} />
      <Knob value={size} min={0} max={1} defaultValue={def('size').defaultValue} label="Size" curve="linear" onchange={setParam('size')} moduleId={id} paramId="size" readLive={readLive('size')} />
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
