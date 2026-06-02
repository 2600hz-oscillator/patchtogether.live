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
  //   - channel / lastDeviceId persist in node.data (synced across
  //     collaborators via Yjs).

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type {
    MidiOutBuddyApi,
    MidiOutBuddyCardState,
    MidiOutBuddyData,
  } from '$lib/audio/modules/midi-out-buddy';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardState = $state<MidiOutBuddyCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    channel: 1,
    activeNote: null,
  });

  let savedData = $derived(((node?.data ?? {}) as Partial<MidiOutBuddyData>));
  let channel = $derived<number>(savedData.channel ?? 1);

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
    const ch = Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10);
    getApi()?.setChannel(ch);
    writeData({ channel: ch });
  }

  // Three CV/gate inputs, no outputs (terminal MIDI sink).
  const inputs: PortDescriptor[] = [
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'pitch', label: 'PITCH', cable: 'cv' },
    { id: 'velocity', label: 'VEL', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [];

  let activeNoteLabel = $derived(
    cardState.activeNote === null ? '—' : noteNameForMidi(cardState.activeNote).toUpperCase(),
  );
</script>

<div class="mod-card midi-out-buddy-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDI CV BUDDY OUT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if !cardState.connected}
        <button class="connect-btn" type="button" onclick={onClickConnect}>
          Connect MIDI…
        </button>
        {#if cardState.permissionDenied}
          <div class="hint err">Permission denied or browser unsupported.</div>
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

        <label class="row">
          <span class="lbl">CH</span>
          <select onchange={onChangeChannel} value={String(channel)}>
            {#each Array(16) as _, i (i)}
              <option value={String(i + 1)}>{i + 1}</option>
            {/each}
          </select>
        </label>

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
