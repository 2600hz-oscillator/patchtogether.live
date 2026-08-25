<script lang="ts">
  // MidiOutBuddyCard — UI for the MIDI-OUT-BUDDY module (label "MIDI CV
  // BUDDY OUT"). The OUTPUT complement of MidiCvBuddyCard: instead of
  // turning external MIDI into CV, it turns the rack's gate/pitch/velocity
  // CV into MIDI notes sent to a selected external MIDI OUTPUT device.
  //
  // The card owns: a "Connect MIDI…" button (calls navigator.requestMIDIAccess
  // via the engine handle's card-api), an OUTPUT device-picker dropdown, a
  // channel selector (1..16), the three input ports (gate / pitch / velocity),
  // and a small note-activity indicator that lights when a note is sounding
  // on the external device.
  //
  // Permission UX mirrors MIDI-CV-BUDDY: no access is requested on mount;
  // the user clicks "Connect MIDI…" once per origin.
  //
  // State scopes:
  //   - Card state (connection, device list, active note) lives on the engine
  //     handle and is read via the 'card-api' subscription.
  //   - midiOutChannel / lastDeviceId persist in node.data (synced across
  //     collaborators via Yjs).
  //
  // CHANNEL vs LANE (#1168): `node.data.channel` belongs to the WORKFLOW
  // CHANNEL-COLUMN system (lane membership, 1..8) — this card must NEVER write
  // it, or the column reconciler moves the module to another lane and drops its
  // clip assignment. The MIDI-out channel is its own key, `midiOutChannel`, and
  // is only *defaulted* from the lane (see effectiveMidiOutChannel). When the
  // two differ the card is highlighted VIOLET so a divergent MIDI route reads
  // at a glance.

  import { onDestroy } from 'svelte';
  import type * as Y from 'yjs';
  import { getYjsValue } from '@syncedstore/core';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    channelForChoice,
    effectiveMidiOutChannel,
    isMidiOutChannelOverridden,
    laneChannelOf,
    midiOutBuddyChannelChoices,
    midiOutBuddyDef,
    type MidiOutBuddyApi,
    type MidiOutBuddyCardState,
    type MidiOutBuddyData,
  } from '$lib/audio/modules/midi-out-buddy';
  import { portsFromDef } from './card-kit';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardState = $state<MidiOutBuddyCardState>({
    connected: false,
    permissionDenied: false, accessMessage: '',
    devices: [],
    selectedDeviceId: null,
    channel: 1,
    activeNote: null,
  });

  // node.data is a LIVE SyncedStore/Yjs proxy, NOT a Svelte signal, so neither
  // our own writes, a peer's, nor the column reconciler's lane move can wake a
  // $derived on their own. Bump a real $state from a Yjs observer scoped to
  // THIS node's entry (the BackdraftCard / toybox pattern) and read it in every
  // channel derivation below, so both channel scalars stay live.
  let dataVersion = $state(0);
  $effect(() => {
    const nodeId = id;
    const yNodes = getYjsValue(patch.nodes) as Y.Map<unknown> | undefined;
    if (!yNodes || typeof yNodes.observeDeep !== 'function') return;
    const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
      for (const ev of events) {
        // path[0] is the node id for a nested write (data/params); a root-level
        // event is a wholesale entry add/replace/remove.
        const hit = ev.path.length === 0 ? ev.changes.keys.has(nodeId) : ev.path[0] === nodeId;
        if (hit) {
          dataVersion++;
          return;
        }
      }
    };
    yNodes.observeDeep(handler);
    return () => yNodes.unobserveDeep(handler);
  });

  function readData(): Partial<MidiOutBuddyData> {
    return (node?.data ?? {}) as Partial<MidiOutBuddyData>;
  }
  /** The channel MIDI is SENT on: explicit override, else the lane's channel. */
  let channel = $derived.by<number>(() => {
    void dataVersion;
    return effectiveMidiOutChannel(readData());
  });
  /** The lane/column this module belongs to (null = not in a lane). */
  let laneChannel = $derived.by<number | null>(() => {
    void dataVersion;
    return laneChannelOf(readData());
  });
  /** In a lane AND routing somewhere else → violet "overridden" highlight. */
  let channelOverridden = $derived.by<boolean>(() => {
    void dataVersion;
    return isMidiOutChannelOverridden(readData());
  });

  function getApi(): MidiOutBuddyApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiOutBuddyApi | undefined) ?? null;
  }

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = id;
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

  function writeData(patch_: Partial<MidiOutBuddyData>): void {
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
    writeData({ lastDeviceId: sel });
  }

  function onChangeChannel(ev: Event): void {
    const ch = channelForChoice((ev.currentTarget as HTMLSelectElement).value);
    getApi()?.setChannel(ch);
    // ONLY `midiOutChannel` — writing `channel` would hand the value to the
    // channel-column reconciler as a LANE REASSIGNMENT (#1168).
    writeData({ midiOutChannel: ch });
  }

  // Keep the engine's send-channel in step with the derived effective channel,
  // so a module that has NOT been overridden still follows its lane when it is
  // moved between columns (setChannel is idempotent — a no-op when unchanged).
  $effect(() => {
    const ch = channel;
    getApi()?.setChannel(ch);
  });

  // Jacks DERIVED FROM THE DEF, never re-typed here. This list used to be three
  // hand-written descriptors, and when the def gained its `poly` input the card
  // silently kept rendering three jacks — the poly bus was unpatchable from the
  // card while the docs said it existed (modules.spec's handle-count gate caught
  // it: expected 4, got 3). That is the "a CARD can silently disagree with its
  // DEF" class in CLAUDE.md; deriving removes it by construction, so the next
  // port added to the def gets a jack for free.
  // Short faceplate labels only — the ids, cable types and the SET of ports all
  // come from the def.
  const inputs: PortDescriptor[] = portsFromDef(midiOutBuddyDef.inputs, {
    poly: 'POLY',
    gate: 'GATE',
    pitch: 'PITCH',
    velocity: 'VEL',
  });
  const outputs: PortDescriptor[] = portsFromDef(midiOutBuddyDef.outputs); // none — terminal MIDI sink

  let activeNoteLabel = $derived(
    cardState.activeNote === null ? '—' : noteNameForMidi(cardState.activeNote).toUpperCase(),
  );
</script>

<!-- data-ch-override is BOTH the styling hook and the state the e2e reads: one
     source of truth for "this module routes MIDI off its lane". -->
<div class="mod-card midi-out-buddy-card" data-ch-override={channelOverridden ? 'true' : 'false'}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDI CV BUDDY OUT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if !cardState.connected}
        <!-- ⚠ CARRIES THE CONTROL FAMILY'S `testidPrefix`. `midi-out-buddy-connect`
             is declared on the def as a `controlFamilies` entry so the faceplate
             can rank the permission gesture as an `action` cell, and
             `module-docs-lint`'s card-drift leg requires every declared prefix
             to appear in real card markup. -->
        <button
          class="connect-btn"
          type="button"
          data-testid="midi-out-buddy-connect-{id}"
          onclick={onClickConnect}
        >
          Connect MIDI…
        </button>
        {#if cardState.accessMessage}
          <!-- Actionable, and covers the SUPPRESSED-prompt case that used to
               produce no message at all (see $lib/audio/midi-access). -->
          <div class="hint err" data-testid="midioutbuddy-access-error-{id}">
            {cardState.accessMessage}
          </div>
        {:else}
          <div class="hint">Click to grant MIDI access (one-time per origin).</div>
        {/if}
      {:else}
        <label class="row">
          <span class="lbl">OUT</span>
          <select onchange={onChangeDevice} value={cardState.selectedDeviceId ?? ''}>
            <option value="" disabled>(pick one)</option>
            {#each cardState.devices as d (d.id)}
              <option value={d.id}>{d.name}</option>
            {/each}
          </select>
        </label>

        <label class="row ch">
          <span class="lbl">CH</span>
          <!-- The roster is IMPORTED, never re-typed: this used to spell
               `{#each Array(16)}` with an inline `i + 1`, and the faceplate's
               selector cell now reads the same function off the def. -->
          <select
            data-testid="midi-out-buddy-channel-{id}"
            onchange={onChangeChannel}
            value={String(channel)}
          >
            {#each midiOutBuddyChannelChoices() as c (c.value)}
              <option value={c.value}>{c.label}</option>
            {/each}
          </select>
        </label>

        {#if channelOverridden}
          <div
            class="ch-badge"
            data-testid="midiout-ch-override-badge"
            title={`MIDI is sent on channel ${channel}, but this module lives in lane ${laneChannel}. Set CH back to ${laneChannel} to follow the lane.`}
          >
            ↯ CH {channel} ≠ LANE {laneChannel}
          </div>
        {/if}

        <div class="readout">
          <div class="readout-row">
            <span class="lbl">NOTE</span>
            <span class="val" class:active={cardState.activeNote !== null}>{activeNoteLabel}</span>
            <span class="dot" class:lit={cardState.activeNote !== null}></span>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .midi-out-buddy-card { width: 220px; }
  /* CHANNEL OVERRIDE — the module is in a lane but sends MIDI on a DIFFERENT
     channel. Violet (the app's --cable-video domain hue, the only purple in the
     token set) so a divergent route is unmistakable next to the amber gate
     stripe. Outline + shadow only, so the card's geometry never shifts. */
  .midi-out-buddy-card[data-ch-override='true'] {
    outline: 1px solid var(--cable-video, #b57bff);
    outline-offset: -1px;
    box-shadow: 0 0 10px -2px var(--cable-video, #b57bff);
  }
  .midi-out-buddy-card[data-ch-override='true'] .row.ch .lbl,
  .midi-out-buddy-card[data-ch-override='true'] .row.ch select {
    color: var(--cable-video, #b57bff);
  }
  .midi-out-buddy-card[data-ch-override='true'] .row.ch select {
    border-color: var(--cable-video, #b57bff);
  }
  .midi-out-buddy-card .ch-badge {
    align-self: flex-start;
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--cable-video, #b57bff);
    border: 1px solid var(--cable-video, #b57bff);
    border-radius: 2px;
    padding: 2px 3px;
    font-family: var(--mono, ui-monospace, monospace);
    pointer-events: none;
  }
  .midi-out-buddy-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .midi-out-buddy-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-gate, #c6c);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .midi-out-buddy-card .connect-btn:hover { filter: brightness(1.15); }
  .midi-out-buddy-card .hint {
    font-size: 10px;
    color: var(--muted, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .midi-out-buddy-card .hint.err { color: #d66; }
  .midi-out-buddy-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .midi-out-buddy-card .row .lbl {
    min-width: 42px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .midi-out-buddy-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .midi-out-buddy-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .midi-out-buddy-card .readout-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .midi-out-buddy-card .readout-row .lbl { min-width: auto; }
  .midi-out-buddy-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
    flex: 1;
    text-align: right;
    margin-right: 6px;
  }
  .midi-out-buddy-card .readout-row .val.active { color: var(--cable-gate, #c6c); }
  .midi-out-buddy-card .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border, #444);
    flex: 0 0 auto;
  }
  .midi-out-buddy-card .dot.lit {
    background: var(--cable-gate, #c6c);
    box-shadow: 0 0 6px var(--cable-gate, #c6c);
  }
</style>
