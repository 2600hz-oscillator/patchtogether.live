<script lang="ts">
  // MOOG 911A DUAL TRIGGER DELAY card — two independent trigger delays of the
  // Moog System 55 clone family. Two gate inputs (TRIG 1/2) feed two delayed
  // gate outputs (OUT 1/2). DELAY 1 / DELAY 2 knobs set each delay time; the
  // MODE knob picks the coupling (OFF / PARALLEL / SERIES), with the current
  // mode name shown beneath the knob.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as Moog962Card / Moog992Card / MoogCp3MixerCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog911aDef, MOOG911A_MODE_NAMES } from '$lib/audio/modules/moog911a';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog911aDef.params.find((p) => p.id === pid)!;
  }

  let delay1 = $derived(node?.params.delay1 ?? def('delay1').defaultValue);
  let delay2 = $derived(node?.params.delay2 ?? def('delay2').defaultValue);
  let mode = $derived(node?.params.mode ?? def('mode').defaultValue);
  // Current coupling-mode name shown under the MODE knob.
  let modeName = $derived(
    MOOG911A_MODE_NAMES[Math.max(0, Math.min(MOOG911A_MODE_NAMES.length - 1, Math.round(mode)))],
  );

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

  // Two gate triggers (left); two delayed gate outputs (right).
  const inputs: PortDescriptor[] = [
    { id: 'trig1', label: 'TRIG 1', cable: 'gate' },
    { id: 'trig2', label: 'TRIG 2', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1', label: 'OUT 1', cable: 'gate' },
    { id: 'out2', label: 'OUT 2', cable: 'gate' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="moogafakkin 911A Trig Delay" width={200}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row" data-testid="moog911a-knobs">
      <Knob
        value={delay1}
        min={def('delay1').min}
        max={def('delay1').max}
        defaultValue={def('delay1').defaultValue}
        label="Delay 1"
        curve="log"
        onchange={setParam('delay1')}
        moduleId={id}
        paramId="delay1"
        readLive={readLive('delay1')}
      />
      <Knob
        value={delay2}
        min={def('delay2').min}
        max={def('delay2').max}
        defaultValue={def('delay2').defaultValue}
        label="Delay 2"
        curve="log"
        onchange={setParam('delay2')}
        moduleId={id}
        paramId="delay2"
        readLive={readLive('delay2')}
      />
      <div class="mode-knob">
        <Knob
          value={mode}
          min={def('mode').min}
          max={def('mode').max}
          defaultValue={def('mode').defaultValue}
          label="Mode"
          curve="discrete"
          onchange={setParam('mode')}
          moduleId={id}
          paramId="mode"
          readLive={readLive('mode')}
        />
        <div class="mode-label" data-testid="moog911a-mode-name">{modeName}</div>
      </div>
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
  .mode-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .mode-label {
    font-size: 9px;
    letter-spacing: 0.04em;
    margin-top: 2px;
    text-align: center;
  }
</style>
