<script lang="ts">
  // PtzcamCard — CV → physical PTZ camera through the PT-PTZ helper.
  //
  // The binding state lives in the ptz-midi binding layer, not this card: the
  // sysex send runs from the module factory's scheduler tick whether or not
  // any card is mounted, so collapsing the dock never stops the camera —
  // and the helper's watchdog, not this card, is what stops a velocity axis
  // when the app dies. The card is a window onto that state, the camera
  // picker, and the trim knobs.
  //
  // DETERMINISTIC AT REST (VRT): a fresh spawn renders the fixed 'idle' status
  // line, an empty picker, and four knobs at defaults — no timers, no
  // counters, no live numbers.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic } from '$lib/ui/controls';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import { ptzcamDef, type PtzcamCardApi } from '$lib/audio/modules/ptzcam';
  import { connectPtzMidi, ptzMidiVersion } from '$lib/audio/ptz-midi';
  import type { PtzAxisCaps } from '$lib/audio/ptz-sysex';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);
  const { paramVal, set, live, engineCtx } = cardParams(
    ptzcamDef,
    () => id,
    () => node,
  );

  const KNOBS = ['pan', 'tilt', 'zoom', 'slew'] as const;

  /** Bumped by user actions so api-backed reads re-run alongside the store. */
  let revision = $state(0);

  // Mirror the binding-layer version store into rune state with an INIT-TIME
  // subscription. Neither store auto-subscription sugar nor an
  // `$effect(() => store.subscribe(...))` bridge delivered updates here
  // (measured: the store bumped, `midiV` never moved, and every seemingly
  // working bind was riding incidental xyflow data-prop churn re-running the
  // deriveds) — the init-time subscribe + onDestroy pattern does.
  let midiV = $state(0);
  onDestroy(
    ptzMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );

  function api(): PtzcamCardApi | null {
    const engine = engineCtx.get();
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as PtzcamCardApi | undefined) ?? null;
  }

  let status = $derived.by(() => {
    void midiV;
    void revision;
    return api()?.status() ?? null;
  });
  let ports = $derived.by(() => {
    void midiV;
    void revision;
    return api()?.listPorts() ?? [];
  });
  let selected = $derived.by(() => {
    void midiV;
    void revision;
    return api()?.selectedPort() ?? null;
  });
  let problem = $derived(
    status !== null && status.kind !== 'bound' && status.kind !== 'idle' && status.kind !== 'binding',
  );

  function axisModeLabel(axis: PtzAxisCaps | undefined): string {
    if (!axis) return '—';
    if (axis.mode === 'abs') return 'abs';
    if (axis.mode === 'vel') return 'vel';
    return '—';
  }
  let modeLine = $derived.by(() => {
    const caps = status?.caps;
    if (!caps) return null;
    return `pan ${axisModeLabel(caps.pan)} · tilt ${axisModeLabel(caps.tilt)} · zoom ${axisModeLabel(caps.zoom)}`;
  });

  function onConnect(): void {
    // Straight from the click handler — an await above requestMIDIAccess
    // spends the user activation and Chromium refuses to prompt. The access
    // request is app-level, so when the engine handle for THIS node is not
    // built yet (a click can race the reconciler), the gesture still must not
    // be dropped — fall through to the app-level connect (measured: the
    // dropped-gesture path left the card frozen at idle forever).
    const a = api();
    void (a ? a.connect() : connectPtzMidi());
    revision++;
  }

  function onSelectPort(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    api()?.selectPort(value === '' ? null : value);
    revision++;
  }

  const inputs = portsFromDef(ptzcamDef.inputs);
  const outputs = portsFromDef(ptzcamDef.outputs);
</script>

<div class="mod-card ptzcam-card" data-testid={`ptzcam-card-${id}`}>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="PTZ CAM" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="bind-row">
      <span class={`led led-${status?.kind ?? 'idle'}`} data-testid={`ptzcam-led-${id}`}></span>
      {#if status?.kind !== 'bound'}
        <button type="button" class="connect" onclick={onConnect} data-testid={`ptzcam-connect-${id}`}>
          Connect
        </button>
      {/if}
      <select
        aria-label="Camera"
        data-testid={`ptzcam-port-${id}`}
        value={selected ?? ''}
        onchange={onSelectPort}
      >
        <option value="">— first camera —</option>
        {#each ports as port (port)}
          <option value={port}>{port}</option>
        {/each}
        {#if selected !== null && !ports.includes(selected)}
          <option value={selected}>{selected} (offline)</option>
        {/if}
      </select>
    </div>

    <p
      class="status"
      class:problem
      role={problem ? 'alert' : undefined}
      data-testid={`ptzcam-status-${id}`}
    >
      {status?.message ?? 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.'}
    </p>

    {#if modeLine !== null}
      <p class="modes" data-testid={`ptzcam-modes-${id}`}>{modeLine}</p>
    {/if}

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
  .stripe {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 0;
  }
  .bind-row select {
    font-size: 10px;
    max-width: 150px;
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
  .status,
  .modes {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    line-height: 1.3;
    opacity: 0.75;
  }
  .modes {
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
