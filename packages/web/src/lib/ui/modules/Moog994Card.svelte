<script lang="ts">
  // MOOG 994 DUAL MULTIPLES card — the passive MULTIPLE panel of the Moog
  // System 55 clone family. Two INDEPENDENT 1→3 fan-out busses (A + B): a
  // signal patched into a group's IN jack appears, unaltered, on that group's
  // three OUT jacks. No knobs — a multiple is a solder junction, so the card
  // is just the patch panel: the two group inputs (A IN / B IN) on the left
  // and the six fanned outputs (A1–A3 / B1–B3) on the right.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock PatchPanel jacks inherit the Moog-era look — same pattern as
  // MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();

  // Two group inputs (left). Both 'audio' = the permissive default cable: a
  // multiple is signal-agnostic and fans out whatever you patch in.
  const inputs: PortDescriptor[] = [
    { id: 'a_in', label: 'A IN', cable: 'audio' },
    { id: 'b_in', label: 'B IN', cable: 'audio' },
  ];
  // Six fanned outputs (right): the A group's three copies, then the B
  // group's three copies.
  const outputs: PortDescriptor[] = [
    { id: 'a1', label: 'A 1', cable: 'audio' },
    { id: 'a2', label: 'A 2', cable: 'audio' },
    { id: 'a3', label: 'A 3', cable: 'audio' },
    { id: 'b1', label: 'B 1', cable: 'audio' },
    { id: 'b2', label: 'B 2', cable: 'audio' },
    { id: 'b3', label: 'B 3', cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="moogafakkin 994 Mult" width={180}>
  <!-- Passive multiple: no controls, just the fan-out patch panel. -->
  <PatchPanel nodeId={id} {inputs} {outputs} />
</MoogPanel>
