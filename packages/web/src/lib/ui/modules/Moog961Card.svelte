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
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog961Def } from '$lib/audio/modules/moog961';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog961Def.params.find((p) => p.id === pid)!;
  }

  let sensitivity = $derived(node?.params.sensitivity ?? def('sensitivity').defaultValue);
  let switchOnTime = $derived(node?.params.switchOnTime ?? def('switchOnTime').defaultValue);

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

  // audio input + S / V trigger inputs (left); V / S trigger outputs (right).
  const inputs = portsFromDef(moog961Def.inputs, {
    audio_in: 'AUDIO', s_in: 'S IN', v_in_a: 'V A', v_in_b: 'V B',
  });
  const outputs = portsFromDef(moog961Def.outputs, {
    v_out1: 'V 1', v_out2: 'V 2', s_out_a: 'S A', s_out_b: 'S B',
  });
</script>

<MoogPanel {id} {data} defaultLabel="961 Interface" width={220}>
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
