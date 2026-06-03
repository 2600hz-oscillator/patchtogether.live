<script lang="ts">
  // MOOG 961 INTERFACE card — the Moog System 55 trigger/gate format-converter
  // faceplate. Two knobs: SENSITIVITY (audio→trigger threshold) and SWITCH-ON
  // TIME (the column-B fixed pulse width). The patch panel exposes the audio
  // input, the S / V trigger inputs, and the V / S trigger outputs.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same reuse
  // contract as Moog911Card / Moog992Card.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog961Def } from '$lib/audio/modules/moog961';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog961Def.params.find((p) => p.id === pid)!;
  }

  let sensitivity = $derived(node?.params.sensitivity ?? def('sensitivity').defaultValue);
  let switchOnTime = $derived(node?.params.switchOnTime ?? def('switchOnTime').defaultValue);

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

  // audio input + S / V trigger inputs (left); V / S trigger outputs (right).
  const inputs: PortDescriptor[] = [
    { id: 'audio_in', label: 'AUDIO', cable: 'audio' },
    { id: 's_in',     label: 'S IN',  cable: 'gate' },
    { id: 'v_in_a',   label: 'V A',   cable: 'gate' },
    { id: 'v_in_b',   label: 'V B',   cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'v_out1',  label: 'V 1',  cable: 'gate' },
    { id: 'v_out2',  label: 'V 2',  cable: 'gate' },
    { id: 's_out_a', label: 'S A',  cable: 'gate' },
    { id: 's_out_b', label: 'S B',  cable: 'gate' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="moogafakkin 961 Interface" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- SENSITIVITY (audio→trigger threshold) + SWITCH-ON TIME (col-B pulse). -->
    <div class="knob-row" data-testid="moog961-knob-row">
      <Knob value={sensitivity} min={0} max={1} defaultValue={0.5} label="Sens" curve="linear" onchange={setParam('sensitivity')} moduleId={id} paramId="sensitivity" readLive={readLive('sensitivity')} />
      <Knob value={switchOnTime} min={0.04} max={4} defaultValue={0.2} label="Sw-On" units="s" curve="log" onchange={setParam('switchOnTime')} moduleId={id} paramId="switchOnTime" readLive={readLive('switchOnTime')} />
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
