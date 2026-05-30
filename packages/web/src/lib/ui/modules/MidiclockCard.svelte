<script lang="ts">
  // MidiclockCard — UI for the MIDICLOCK module.
  //
  // Pattern mirrors MidiCvBuddyCard: Connect button (one-time per origin),
  // device picker, and a divisor selector for the clock output rate.
  // Live status: RUN indicator + total ticks observed since connect.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    CLOCK_DIVISORS,
    divisorLabel,
    isValidDivisor,
    type ClockDivisor,
    type MidiclockApi,
    type MidiclockCardState,
    type MidiclockData,
  } from '$lib/audio/modules/midiclock';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardState = $state<MidiclockCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    running: false,
    divisor: 24,
    ticksReceived: 0,
  });

  let savedData = $derived((node?.data ?? {}) as Partial<MidiclockData>);
  let divisor = $derived<ClockDivisor>(
    isValidDivisor(savedData.divisor) ? savedData.divisor : 24,
  );

  function getApi(): MidiclockApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiclockApi | undefined) ?? null;
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

  function writeData(patch_: Partial<MidiclockData>): void {
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

  function onChangeDivisor(ev: Event): void {
    const raw = Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10);
    if (!isValidDivisor(raw)) return;
    getApi()?.setDivisor(raw);
    writeData({ divisor: raw });
  }

  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'clock',     label: 'CLK',   cable: 'gate' },
    { id: 'run',       label: 'RUN',   cable: 'cv'   },
    { id: 'midistart', label: 'START', cable: 'gate' },
    { id: 'midistop',  label: 'STOP',  cable: 'gate' },
  ];
</script>

<div class="mod-card midiclock-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDICLOCK" />

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
          <span class="lbl">DEVICE</span>
          <select onchange={onChangeDevice} value={cardState.selectedDeviceId ?? ''}>
            <option value="" disabled>(pick one)</option>
            {#each cardState.devices as d (d.id)}
              <option value={d.id}>{d.name}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">DIV</span>
          <select onchange={onChangeDivisor} value={String(divisor)}>
            {#each CLOCK_DIVISORS as d (d)}
              <option value={String(d)}>{divisorLabel(d)}</option>
            {/each}
          </select>
        </label>

        <div class="readout">
          <div class="readout-row">
            <span class="lbl">STATE</span>
            <span class="val state" class:running={cardState.running}>
              {cardState.running ? 'RUN' : 'STOP'}
            </span>
          </div>
          <div class="readout-row">
            <span class="lbl">TICKS</span>
            <span class="val">{cardState.ticksReceived}</span>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .midiclock-card { width: 200px; }
  .midiclock-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .midiclock-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-gate, #ec6);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .midiclock-card .connect-btn:hover { filter: brightness(1.15); }
  .midiclock-card .hint {
    font-size: 10px;
    color: var(--muted, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .midiclock-card .hint.err { color: #d66; }
  .midiclock-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .midiclock-card .row .lbl {
    min-width: 42px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .midiclock-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .midiclock-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .midiclock-card .readout-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .midiclock-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
  }
  .midiclock-card .readout-row .val.state {
    color: var(--muted, #888);
  }
  .midiclock-card .readout-row .val.state.running {
    color: var(--cable-gate, #ec6);
  }
</style>
