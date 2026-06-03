<script lang="ts">
  // MOOG 902 VCA card — slice 3 of the Moog System 55/35 clone. Laid out to
  // echo the original 902 faceplate (Fig 9): a large GAIN pot ("fixed control
  // voltage"), a CV depth knob, a LIN / EXP RESPONSE switch, the summing
  // CONTROL INPUT jacks (cv + fcv) + the SIGNAL INPUT jack on the left, and
  // the two OUTPUT jacks (the differential pair — OUT + the phase-inverted
  // OUT−) on the right.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog921VcoCard + Moog904aVcfCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog902Def } from '$lib/audio/modules/moog902';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog902Def.params.find((p) => p.id === pid)!;
  }

  let gain     = $derived(node?.params.gain     ?? def('gain').defaultValue);
  let cvAmount = $derived(node?.params.cvAmount ?? def('cvAmount').defaultValue);
  let mode     = $derived(node?.params.mode     ?? def('mode').defaultValue);

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

  // RESPONSE is a 2-position switch (LINEAR / EXPONENTIAL) → 0 / 1.
  const MODE_POS: Array<{ v: number; label: string }> = [
    { v: 0, label: 'LIN' },
    { v: 1, label: 'EXP' },
  ];
  function setMode(v: number) {
    const target = patch.nodes[id];
    if (target) target.params.mode = v;
  }

  // CONTROL INPUTS (summing) + SIGNAL INPUT on the left; the differential
  // output pair (OUT + phase-inverted OUT−) on the right.
  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'SIGNAL', cable: 'audio' },
    { id: 'cv',    label: 'CTRL',   cable: 'cv' },
    { id: 'fcv',   label: 'FCV',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio',     label: 'OUT',  cable: 'audio' },
    { id: 'audio_inv', label: 'OUT−', cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="moogafakkin 902 VCA" width={236}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- GAIN ("fixed control voltage") + CV depth. -->
    <div class="knob-row" data-testid="moog902-knob-row">
      <Knob value={gain} min={0} max={1} defaultValue={0.5} label="Gain" curve="linear" onchange={setParam('gain')} moduleId={id} paramId="gain" readLive={readLive('gain')} />
      <Knob value={cvAmount} min={-1} max={1} defaultValue={1} label="CV" curve="linear" onchange={setParam('cvAmount')} moduleId={id} paramId="cvAmount" readLive={readLive('cvAmount')} />
    </div>

    <!-- RESPONSE switch (LINEAR / EXPONENTIAL). -->
    <div class="mode-row" data-testid="moog902-mode-switch">
      <span class="mode-label">RESP</span>
      <div class="mode-seg" role="radiogroup" aria-label="Response mode">
        {#each MODE_POS as pos (pos.v)}
          <button
            type="button"
            class="mode-btn"
            class:active={mode === pos.v}
            role="radio"
            aria-checked={mode === pos.v}
            data-mode-value={pos.v}
            onclick={() => setMode(pos.v)}
          >{pos.label}</button>
        {/each}
      </div>
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 18px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
  .mode-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px 2px;
    justify-content: center;
  }
  .mode-label {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .mode-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .mode-btn {
    appearance: none;
    border: none;
    background: var(--module-bg-deep);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 3px 11px;
    cursor: pointer;
    border-right: 1px solid var(--border);
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .mode-btn:last-child {
    border-right: none;
  }
  .mode-btn:hover {
    color: var(--text);
  }
  .mode-btn.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .mode-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
