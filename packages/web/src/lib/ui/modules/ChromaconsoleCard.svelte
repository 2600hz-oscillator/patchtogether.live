<script lang="ts">
  // ChromaconsoleCard — control surface for the Hologram Chroma Console pedal.
  //
  // ══════════════════ THE CARD MUST NOT IMPLY IT KNOWS THE PEDAL ══════════════════
  //
  // The device is RECEIVE-ONLY. There is no state query, no dump, no handshake
  // — the app can talk and never listen. So this card is careful about a
  // distinction that is easy to blur and impossible to fix later:
  //
  //   * "connected" means A PORT IS SELECTED. It does NOT mean the pedal is
  //     there, powered, on the right MIDI channel, or showing these values.
  //   * every knob shows WHAT THE APP LAST SENT. A hand on the physical knob
  //     desyncs it silently and we cannot detect that.
  //
  // There is deliberately no "synced" light, no checkmark, and no green state.
  // A reassuring indicator would be a lie, and the one thing worse than an
  // unsynced device is an unsynced device that claims otherwise. PUSH ALL is
  // the only reconciliation that exists and it is user-initiated.
  //
  // ═════════════════════ DETERMINISTIC AT REST (VRT) ═════════════════════
  //
  // The card carries a committed VRT baseline, so its resting render must be
  // byte-stable: no message counters, no activity blink, no elapsed times, no
  // "last CC sent" readout. Those would flap the baseline on every capture —
  // and, conveniently, the "last CC sent" readout is also the element that most
  // tempts a reader into thinking the card mirrors the pedal. The two
  // constraints agree. Transmission detail is observable through the engine
  // handle's ledger (`read('ledger')`), which is where the e2e looks.

  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic, Segmented } from '$lib/ui/controls';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import { chromaconsoleDef } from '$lib/audio/modules/chromaconsole';
  import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
  import {
    DEVICE_SLOT_IDS,
    type DeviceCardApi,
    type DeviceStatus,
  } from '$lib/devices/device-module';
  import {
    actionControls,
    controlById,
    enumRangeValue,
    formatControlValue,
    slottableControls,
    type DeviceControl,
  } from '$lib/devices/device-descriptor';
  import { chromaconsoleAutoSelectPort } from './chromaconsole-cell-actions';
  import { chromaconsoleSlotName } from './chromaconsole/chromaconsole-status-model';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);

  const { paramVal, set, live, engineCtx } = cardParams(
    chromaconsoleDef,
    () => id,
    () => node,
  );

  /** Bumped by user actions so the status/assignment reads re-run. There is no
   *  polling timer: nothing on this card changes on its own, which is what
   *  keeps the resting render stable. */
  let revision = $state(0);

  function api(): DeviceCardApi | null {
    const engine = engineCtx.get();
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as DeviceCardApi | undefined) ?? null;
  }

  const EMPTY_STATUS: DeviceStatus = {
    connected: false, portId: null, portName: null, channel: CHROMA_CONSOLE.defaultChannel,
    problem: '', staleSlots: [], delivered: 0, undelivered: 0,
  };

  let status = $derived.by((): DeviceStatus => {
    void revision;
    return api()?.status() ?? EMPTY_STATUS;
  });

  let outputs = $derived.by((): { id: string; name: string }[] => {
    void revision;
    return api()?.listOutputs() ?? [];
  });

  let slots = $derived.by(() => {
    void revision;
    return api()?.slots() ?? [];
  });

  const SLOTTABLE = slottableControls(CHROMA_CONSOLE);
  const ACTIONS = actionControls(CHROMA_CONSOLE);

  /** Group the slottable controls for the assignment picker. */
  const GROUPED = (() => {
    const byGroup = new Map<string, DeviceControl[]>();
    for (const c of SLOTTABLE) {
      const list = byGroup.get(c.group) ?? [];
      list.push(c);
      byGroup.set(c.group, list);
    }
    return [...byGroup.entries()];
  })();

  async function onConnect(): Promise<void> {
    const a = api();
    if (!a) return;
    // Straight from the click handler — an await before requestMIDIAccess
    // spends the user activation and Chromium refuses to prompt.
    await a.connect();
    // ⚠ AUTO-DETECT NOW ROUTES THROUGH THE SHARED SEAM, AND THAT IS A BEHAVIOUR
    // FIX. This card used to re-implement the match inline as "earliest PORT
    // that matches any hint", while `matchPortByHint` — which had a full unit
    // suite and ZERO production callers — is "earliest HINT that matches any
    // port". The descriptor orders its hints most-specific-first on purpose, so
    // with both a DIN interface enumerating as "Chroma" and the real pedal
    // present, the card bound the interface and the descriptor's ordering was
    // silently defeated. One implementation now serves the card and the face's
    // ranked CONNECT cell.
    chromaconsoleAutoSelectPort(a);
    revision++;
  }

  function onSelectPort(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    api()?.selectPort(value === '' ? null : value);
    revision++;
  }

  function onSelectChannel(event: Event): void {
    api()?.setChannel(Number((event.currentTarget as HTMLSelectElement).value));
    revision++;
  }

  function onAssign(slotId: string, event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    api()?.assignSlot(slotId, value === '' ? null : value);
    revision++;
  }

  function onPushAll(): void {
    api()?.pushAll();
    revision++;
  }

  function onFireAction(controlId: string): void {
    api()?.fireAction(controlId);
    revision++;
  }

  /** Readout text for a slot, via the descriptor's NAMED format spec — never a
   *  closure on the ParamDef. */
  function readoutFor(controlId: string | undefined, value: number): string {
    const control = controlById(CHROMA_CONSOLE, controlId);
    return control ? formatControlValue(control, value) : String(Math.round(value));
  }

  /**
   * A knob label short enough for a 4-across grid cell.
   *
   * ⚠ THE ARITHMETIC MOVED, THE ANSWER DID NOT. It lives in
   * `chromaconsole/chromaconsole-status-model` because the face's device body
   * needs the same short name for its slot board, and a hand-copy is how the two
   * surfaces would drift. Same rule as before: the descriptor's labels are
   * qualified for the assignment picker, where the distinction matters
   * ("amount · character" vs "effect vol · character"), and on the control
   * itself the qualifier is already visible in the select directly above it.
   */
  const knobLabel = chromaconsoleSlotName;

  /** Enum controls render as a Segmented that writes each range's midpoint. */
  function segmentOptions(control: DeviceControl) {
    return (control.ranges ?? []).map((r) => ({
      value: enumRangeValue(r),
      label: r.label,
    }));
  }
</script>

<div class="mod-card chroma-console" data-testid={`chromaconsole-card-${id}`}>
  <ModuleTitle {id} {data} defaultLabel="CHROMA CONSOLE" />

  <!-- Connection. "Connected" here means a port is selected — see the header. -->
  <div class="row">
    {#if !status.connected}
      <button type="button" class="connect" onclick={onConnect} data-testid={`chromaconsole-connect-${id}`}>
        Connect MIDI…
      </button>
    {/if}
    <select
      aria-label="MIDI output"
      data-testid={`chromaconsole-port-${id}`}
      value={status.portId ?? ''}
      onchange={onSelectPort}
    >
      <option value="">— no output —</option>
      {#each outputs as out (out.id)}
        <option value={out.id}>{out.name}</option>
      {/each}
    </select>
    <select
      aria-label="MIDI channel"
      data-testid={`chromaconsole-channel-${id}`}
      value={String(status.channel)}
      onchange={onSelectChannel}
    >
      {#each Array.from({ length: 16 }, (_, i) => i + 1) as ch (ch)}
        <option value={String(ch)}>ch {ch}</option>
      {/each}
    </select>
  </div>

  {#if status.problem}
    <p class="problem" data-testid={`chromaconsole-problem-${id}`}>{status.problem}</p>
  {/if}

  {#if status.staleSlots.length > 0}
    <!-- A saved assignment that no longer resolves. Loud on purpose: a slot
         that quietly behaved like an empty one would leave automation writing
         into a dead lane with nothing anywhere saying so. -->
    <p class="stale" data-testid={`chromaconsole-stale-${id}`}>
      {status.staleSlots.length} slot(s) point at controls this device no longer has. Reassign them.
    </p>
  {/if}

  <!-- The open-loop statement. Permanent, not a transient toast: it is true at
       every moment, not just after an error. -->
  <p class="openloop">
    Send-only — the pedal cannot report back. These show what was sent, not what the pedal holds.
  </p>

  <div class="slots">
    {#each DEVICE_SLOT_IDS as slotId, index (slotId)}
      {@const spec = paramSpec(chromaconsoleDef, slotId)}
      {@const slot = slots[index]}
      {@const control = slot?.control}
      <div class="slot" data-testid={`chromaconsole-slot-${id}-${index + 1}`}>
        <select
          aria-label={`Slot ${index + 1} assignment`}
          data-testid={`chromaconsole-assign-${id}-${index + 1}`}
          value={slot?.controlId ?? ''}
          onchange={(e) => onAssign(slotId, e)}
        >
          <option value="">— unassigned —</option>
          {#each GROUPED as [group, controls] (group)}
            <optgroup label={group}>
              {#each controls as c (c.id)}
                <option value={c.id}>{c.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>

        {#if control && control.role === 'enum'}
          <!-- moduleId + paramId are what make this control MIDI-assignable.
               `Segmented` is generic over string|number values, so `onchange`
               narrows to a number at the boundary rather than widening the
               param write to accept a string it can never receive. -->
          <Segmented
            value={paramVal(slotId)}
            segments={segmentOptions(control)}
            label={control.label}
            moduleId={id}
            paramId={slotId}
            onchange={(v) => set(slotId)(Number(v))}
            snapActive
          />
        {:else}
          <!-- min/max/curve/defaultValue come from the DEF via paramSpec — never
               re-typed here. A card that restates a range is free to disagree
               with it, and no runtime gate can see that. -->
          <KnobConic
            value={paramVal(slotId)}
            min={spec.min}
            max={spec.max}
            defaultValue={spec.defaultValue}
            curve={spec.curve}
            label={knobLabel(control, index)}
            moduleId={id}
            paramId={slotId}
            onchange={set(slotId)}
            readLive={live(slotId)}
          />
          <span class="readout">{readoutFor(slot?.controlId, paramVal(slotId))}</span>
        {/if}

        {#if control?.quantize}
          <!-- The pedal snaps this and cannot be told not to. Saying so on the
               control is the only way the user can reconcile a smooth-looking
               number with a stepped-sounding result. -->
          <span class="snap" title={control.quantize.note}>pedal-snapped</span>
        {/if}
      </div>
    {/each}
  </div>

  <div class="row actions">
    <button type="button" onclick={onPushAll} data-testid={`chromaconsole-pushall-${id}`}>
      Push all to device
    </button>
    {#each ACTIONS as action (action.id)}
      <button
        type="button"
        title={action.doc}
        data-testid={`chromaconsole-action-${id}-${action.id}`}
        onclick={() => onFireAction(action.id)}
      >
        {action.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .chroma-console {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    /* 2 × the 180px rack tile, so the card lands on the grid. */
    width: 360px;
    box-sizing: border-box;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .actions {
    margin-top: 4px;
  }
  select,
  button {
    font-size: 10px;
    max-width: 100%;
  }
  .slots {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 0;
    /* Clip rather than overlap: a label that runs into its neighbour is
       harder to read than a truncated one. */
    overflow: hidden;
    text-align: center;
  }
  .slot select {
    max-width: 100%;
    width: 100%;
  }
  .readout {
    font-size: 9px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  .snap {
    font-size: 8px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .openloop,
  .problem,
  .stale {
    margin: 0;
    font-size: 9px;
    line-height: 1.3;
  }
  .openloop {
    opacity: 0.65;
  }
  .problem,
  .stale {
    color: #d98a3a;
  }
</style>
