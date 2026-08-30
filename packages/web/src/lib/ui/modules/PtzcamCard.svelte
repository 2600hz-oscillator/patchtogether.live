<script lang="ts">
  // PtzcamCard — CV → physical PTZ camera through the PT-PTZ helper.
  //
  // The binding state lives in the ptz-midi singleton, not this card: the
  // sysex send runs from the module factory's scheduler tick whether or not
  // any card is mounted, so collapsing the dock never stops the camera
  // (the node-launchpad-monitor lesson). The card is a window onto that state
  // plus the trim knobs.
  //
  // DETERMINISTIC AT REST (VRT): a fresh spawn renders the fixed 'idle' status
  // line and four knobs at defaults — no timers, no counters, no live numbers.

  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic } from '$lib/ui/controls';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import { ptzcamDef } from '$lib/audio/modules/ptzcam';
  import { connectPtzMidi, ptzStatus, ptzStatusRune } from '$lib/audio/ptz-midi.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);
  const { paramVal, set, live } = cardParams(
    ptzcamDef,
    () => id,
    () => node,
  );

  const KNOBS = ['pan', 'tilt', 'zoom', 'slew'] as const;

  let status = $derived((ptzStatusRune(), ptzStatus()));
  let problem = $derived(
    status.kind !== 'bound' && status.kind !== 'idle' && status.kind !== 'binding',
  );

  function onConnect(): void {
    // Straight from the click handler — an await above requestMIDIAccess
    // spends the user activation and Chromium refuses to prompt.
    void connectPtzMidi();
  }

  const inputs = portsFromDef(ptzcamDef.inputs);
  const outputs = portsFromDef(ptzcamDef.outputs);
</script>

<div class="mod-card ptzcam-card" data-testid={`ptzcam-card-${id}`}>
  <ModuleTitle {id} {data} defaultLabel="PTZ CAM" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="bind-row">
      <span class={`led led-${status.kind}`} data-testid={`ptzcam-led-${id}`}></span>
      {#if status.kind !== 'bound'}
        <button type="button" class="connect" onclick={onConnect} data-testid={`ptzcam-connect-${id}`}>
          Connect
        </button>
      {/if}
    </div>

    <p
      class="status"
      class:problem
      role={problem ? 'alert' : undefined}
      data-testid={`ptzcam-status-${id}`}
    >
      {status.message}
    </p>

    <div class="knob-row">
      {#each KNOBS as knobId (knobId)}
        {@const spec = paramSpec(ptzcamDef, knobId)}
        <!-- min/max/curve/defaultValue come from the DEF via paramSpec — never
             re-typed here (card-range-source / card-control-ranges gates). -->
        <KnobConic
          value={paramVal(knobId)}
          min={spec.min}
          max={spec.max}
          defaultValue={spec.defaultValue}
          curve={spec.curve}
          label={knobId}
          moduleId={id}
          paramId={knobId}
          onchange={set(knobId)}
          readLive={live(knobId)}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .ptzcam-card {
    width: 260px;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 0;
  }
  .connect {
    font-size: 10px;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex: none;
  }
  .led-bound {
    background: #4caf7d;
  }
  .led-binding {
    background: #d9c23a;
  }
  .led-no-port,
  .led-no-reply,
  .led-camera-absent,
  .led-denied,
  .led-no-prompt,
  .led-unsupported {
    background: #d98a3a;
  }
  .status {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    line-height: 1.3;
    opacity: 0.75;
  }
  .status.problem {
    color: #d98a3a;
    opacity: 1;
  }
  .knob-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    padding: 8px 14px 10px;
  }
</style>
