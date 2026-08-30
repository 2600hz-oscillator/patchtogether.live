<script lang="ts">
  // MidiCvBuddyCard — UI for the MIDI-CV-BUDDY module.
  //
  // The card owns the user-visible MIDI controls: "Connect MIDI…" button
  // (calls navigator.requestMIDIAccess via the engine handle's card-api),
  // a device-picker dropdown, a channel filter (ALL / 1..16), a voice-
  // priority selector (LAST / LOW / HIGH), and a RETRIG toggle.
  //
  // Permission UX: we DO NOT request MIDI access on module mount — that
  // would spam the permission dialog every time the patch loads. Instead
  // the user clicks "Connect MIDI…" once per browser session per origin
  // (Chrome remembers the grant for the origin so subsequent reloads
  // require zero clicks after the first grant).
  //
  // State scopes:
  //   - Card state (connection status, device list, last note received)
  //     lives on the engine handle (one per node instance) and is read
  //     via engine.read(node, 'state'). The card subscribes via the
  //     'card-api' read to be notified of changes (hot-plug, note-on).
  //   - Channel / priority / retrig / lastDeviceId persist in
  //     node.data — synced across collaborators via Yjs.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type {
    MidiCvBuddyApi,
    MidiCvBuddyCardState,
    MidiCvBuddyData,
  } from '$lib/audio/modules/midi-cv-buddy';
  // ⚠ THE ROSTERS AND THE CHANNEL READ ARE IMPORTED, NEVER RE-TYPED. This card
  // used to spell `{#each Array(16)}` with an inline `i + 1`, and the three
  // priority `<option>`s as literals — two encodings of one convention, which is
  // the same one-place rule the range gates apply to numbers. Both surfaces
  // (this card under `?shell=legacy`, and the faceplate) now read the same
  // functions off the def.
  import {
    channelForChoice,
    choiceForChannel,
    midiCvBuddyChannelChoices,
    midiCvBuddyPriorityOptions,
    midiInChannelOf,
    priorityForChoice,
  } from '$lib/audio/modules/midi-cv-buddy';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import { nameOfDevice } from '$lib/graph/device-rebind';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Card-visible mirror of the engine state. Initialised empty; populated
  // on subscribe (and on subsequent state-changes via the subscriber).
  let cardState = $state<MidiCvBuddyCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    lastNote: null,
    lastVelocity: 0,
    heldCount: 0,
  });

  // Saved data (with defaults).
  let savedData = $derived(((node?.data ?? {}) as Partial<MidiCvBuddyData>));
  // ⚠ `midiInChannelOf`, NEVER `savedData.channel` — `data.channel` is the
  // workflow channel-column reconciler's MEMBERSHIP key, not ours. See that
  // function's header in the def for the measurement.
  let channel = $derived<number | null>(midiInChannelOf(savedData));
  let priority = $derived<string>(savedData.priority ?? 'last');
  let retrig = $derived<boolean>(savedData.retrig ?? true);

  function getApi(): MidiCvBuddyApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiCvBuddyApi | undefined) ?? null;
  }

  // Subscribe to engine state once the engine is up and the card-api is
  // available. The subscription is keyed off the node id so the effect
  // re-runs cleanly if the card remounts.
  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = id; // re-run if id changes (defensive — shouldn't in practice)
    const api = getApi();
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe((s) => { cardState = s; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  async function onClickConnect(): Promise<void> {
    const api = getApi();
    if (!api) return;
    await api.connect();
  }

  function writeData(patch_: Partial<MidiCvBuddyData>): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    for (const [k, v] of Object.entries(patch_)) {
      if (v === undefined) delete target.data[k];
      else (target.data as Record<string, unknown>)[k] = v as unknown;
    }
  }

  function onChangeDevice(ev: Event): void {
    const sel = (ev.currentTarget as HTMLSelectElement).value || null;
    getApi()?.selectDevice(sel);
    // ⚠ THE NAME IS WRITTEN AT PICK TIME because it is the only moment it is
    // knowable. `lastDeviceId` is the MIDIPort.id, which the spec leaves
    // implementation-defined — this file's own bundle exporter calls it
    // "unstable" — so on a later load the id may name nothing, and the
    // remembered name is what still identifies the hardware.
    writeData({
      lastDeviceId: sel,
      lastDeviceName: nameOfDevice(sel, cardState.devices) ?? undefined,
    });
  }

  function onChangeChannel(ev: Event): void {
    const ch = channelForChoice((ev.currentTarget as HTMLSelectElement).value);
    getApi()?.setChannel(ch);
    // ⚠ ONLY `midiInChannel`. Writing `channel` would hand the value to the
    // workflow channel-column reconciler as a LANE REASSIGNMENT — it prunes any
    // node whose `data.channel !== ch` out of column `ch` and adopts it into
    // the column matching the new value, so a MIDI channel of 0..15 either
    // ejected this module from its lane or teleported it into another's. That
    // is #1168, which was fixed on `MidiOutBuddyCard` and never checked here.
    writeData({ midiInChannel: ch });
  }

  function onChangePriority(ev: Event): void {
    const p = priorityForChoice((ev.currentTarget as HTMLSelectElement).value);
    getApi()?.setPriority(p);
    writeData({ priority: p });
  }

  function onToggleRetrig(ev: Event): void {
    const v = (ev.currentTarget as HTMLInputElement).checked;
    getApi()?.setRetrig(v);
    writeData({ retrig: v });
  }

  // No inputs (MIDI is external), three CV outputs.
  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'pitch_cv',    label: 'PITCH',    cable: 'cv' },
    { id: 'gate',        label: 'GATE',     cable: 'gate' },
    { id: 'velocity_cv', label: 'VEL',      cable: 'cv' },
  ];

  let activeNoteLabel = $derived(
    cardState.lastNote === null ? '—' : noteNameForMidi(cardState.lastNote).toUpperCase(),
  );
</script>

<div class="mod-card midi-cv-buddy-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDI-CV-BUDDY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if !cardState.connected}
        <!-- ⚠ CARRIES THE CONTROL FAMILY'S `testidPrefix`. `midi-cv-buddy-connect`
             is declared on the def as a `controlFamilies` entry so the faceplate
             can rank the permission gesture as an `action` cell, and
             `module-docs-lint`'s card-drift leg requires every declared prefix
             to appear in real card markup. -->
        <button
          class="connect-btn"
          type="button"
          data-testid="midi-cv-buddy-connect-{id}"
          onclick={onClickConnect}
        >
          Connect MIDI…
        </button>
        {#if cardState.permissionDenied}
          <div class="hint err">Permission denied or browser unsupported.</div>
        {:else}
          <div class="hint">Click to grant MIDI access (one-time per origin).</div>
        {/if}
      {:else}
        <label class="row">
          <span class="lbl">DEVICE</span>
          <select onchange={onChangeDevice} value={cardState.selectedDeviceId ?? ''}>
            <option value="" disabled>(pick one)</option>
            {#each cardState.devices as d (d.id)}
              <option value={d.id}>{d.name}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">CH</span>
          <select
            data-testid="midi-cv-buddy-channel-{id}"
            onchange={onChangeChannel}
            value={choiceForChannel(channel)}
          >
            {#each midiCvBuddyChannelChoices() as c (c.value)}
              <option value={c.value}>{c.label}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">PRIO</span>
          <select
            data-testid="midi-cv-buddy-priority-{id}"
            onchange={onChangePriority}
            value={priority}
          >
            {#each midiCvBuddyPriorityOptions() as p (p.value)}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </label>

        <label class="row retrig">
          <input
            type="checkbox"
            data-testid="midi-cv-buddy-retrig-{id}"
            checked={retrig}
            onchange={onToggleRetrig}
          />
          <span>RETRIG</span>
        </label>

        <div class="readout">
          <div class="readout-row">
            <span class="lbl">NOTE</span>
            <span class="val">{activeNoteLabel}</span>
          </div>
          <div class="readout-row">
            <span class="lbl">VEL</span>
            <span class="val">{cardState.lastVelocity}</span>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .midi-cv-buddy-card { width: 220px; }
  .midi-cv-buddy-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .midi-cv-buddy-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-cv, #6cc);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .midi-cv-buddy-card .connect-btn:hover { filter: brightness(1.15); }
  .midi-cv-buddy-card .hint {
    font-size: 10px;
    color: var(--muted, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .midi-cv-buddy-card .hint.err { color: #d66; }
  .midi-cv-buddy-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .midi-cv-buddy-card .row .lbl {
    min-width: 42px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .midi-cv-buddy-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .midi-cv-buddy-card .row.retrig {
    gap: 6px;
  }
  .midi-cv-buddy-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .midi-cv-buddy-card .readout-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .midi-cv-buddy-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
  }
</style>
