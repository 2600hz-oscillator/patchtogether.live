<script lang="ts">
  // MidiDinSurface — the WORKFLOW topbar 5-pin-DIN dropdown: assign a MIDI
  // input as TIMELORDE's clock source.
  //
  // It drives the EXISTING midiclock→timelorde bridge, not a parallel
  // path: every workflow rack carries a hidden pinned MIDICLOCK node
  // (graph/workflow-pins.ts), inert until this menu's Connect flow calls
  // its engine-side MidiclockApi (the same `read('card-api')` seam the
  // MidiclockCard uses). ASSIGNING a device = selectDevice() on the bridge
  // + wiring its clock/midistart/midistop outputs to TIMELORDE's
  // clock/start_in/stop_in inputs with ordinary cables — the exact
  // hand-patched wiring both module defs document. TIMELORDE's worklet
  // then measures the incoming pulse period and follows it; the clock
  // surface's tap/knob flip to the externally-clocked state purely off
  // edge-presence, same as a hand-patched clock cable.

  import { onDestroy } from 'svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type {
    MidiclockApi,
    MidiclockCardState,
  } from '$lib/audio/modules/midiclock';
  import type { ModuleNode } from '$lib/graph/types';
  import { planDinAssign, planDinUnassign } from './workflow-surfaces';

  interface Props {
    /** The hidden pinned MIDICLOCK bridge (snapshot-derived; null pre-ensure). */
    midiclock: ModuleNode | null;
    /** THE rack timelorde (see ClockSurface). */
    timelorde: ModuleNode | null;
    /** True while the bridge's clock edge into TIMELORDE exists. */
    assigned: boolean;
    /** Boot the audio engine (Canvas's ensureEngine) — the bridge's
     *  MidiclockApi lives on the ENGINE-side module, and in a fresh rack
     *  the DIN menu can be the user's first gesture. */
    onEnsureEngine?: (() => Promise<unknown>) | null;
  }
  let { midiclock, timelorde, assigned, onEnsureEngine = null }: Props = $props();

  const engineCtx = useEngine();

  let bridgeState = $state<MidiclockCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    running: false,
    divisor: 24,
    ticksReceived: 0,
  });

  function getApi(): MidiclockApi | null {
    const e = engineCtx.get();
    const node = midiclock;
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiclockApi | undefined) ?? null;
  }

  // Subscribe to the bridge's state feed (device list, permission, selected
  // device). The engine may not have materialized the pinned node in the
  // first frames after rack open — poll briefly until the api appears
  // (same race window AudioinCard handles on attach).
  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const node = midiclock;
    if (!node) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const bind = () => {
      if (cancelled) return;
      const api = getApi();
      if (!api) {
        retry = setTimeout(bind, 250);
        return;
      }
      unsubscribe?.();
      unsubscribe = api.subscribe((s) => {
        bridgeState = s;
      });
    };
    bind();
    return () => {
      cancelled = true;
      if (retry !== null) clearTimeout(retry);
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => {
    unsubscribe?.();
  });

  async function onConnect(): Promise<void> {
    // Boot the engine if it isn't up yet (the api lives on the engine-side
    // module), then request MIDI access through the bridge. After the boot
    // the reconciler materializes the pinned bridge asynchronously, so
    // poll briefly for the api before giving up.
    let api = getApi();
    if (!api && onEnsureEngine) {
      try {
        await onEnsureEngine();
      } catch {
        return; // engine refused to boot (e.g. no AudioContext) — leave the hint up
      }
      const deadline = Date.now() + 3000;
      while (!api && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        api = getApi();
      }
    }
    if (!api) return;
    await api.connect();
  }

  /** Persist the picked device on the bridge node (the same
   *  `data.lastDeviceId` the MidiclockCard writes, so a reload reattaches). */
  function writeLastDeviceId(deviceId: string | null): void {
    const node = midiclock;
    if (!node) return;
    const target = patch.nodes[node.id];
    if (!target) return;
    if (!target.data) target.data = {};
    if (deviceId === null) delete target.data['lastDeviceId'];
    else target.data['lastDeviceId'] = deviceId;
  }

  function assignDevice(deviceId: string): void {
    const bridge = midiclock;
    const tl = timelorde;
    if (!bridge || !tl) return;
    const api = getApi();
    api?.selectDevice(deviceId);
    writeLastDeviceId(deviceId);
    // Wire the bridge → TIMELORDE (replacing whatever fed those inputs) in
    // ONE transact so collaborators see the assignment atomically.
    const plan = planDinAssign(Object.values(patch.edges), bridge.id, tl.id);
    ydoc.transact(() => {
      for (const id of plan.deleteIds) delete patch.edges[id];
      for (const e of plan.add) {
        patch.edges[e.id] = {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceType: e.sourceType,
          targetType: e.targetType,
        };
      }
    }, LOCAL_ORIGIN);
  }

  function unassign(): void {
    const bridge = midiclock;
    const tl = timelorde;
    if (!bridge || !tl) return;
    const deleteIds = planDinUnassign(Object.values(patch.edges), bridge.id, tl.id);
    ydoc.transact(() => {
      for (const id of deleteIds) delete patch.edges[id];
    }, LOCAL_ORIGIN);
    getApi()?.selectDevice(null);
    writeLastDeviceId(null);
  }

  let assignedDeviceName = $derived.by(() => {
    if (!assigned) return null;
    const sel = bridgeState.selectedDeviceId;
    if (!sel) return '(midi device)';
    return bridgeState.devices.find((d) => d.id === sel)?.name ?? sel;
  });
</script>

<div class="din-menu" data-testid="workflow-din-menu" role="menu">
  {#if !midiclock || !timelorde}
    <div class="hint" data-testid="workflow-din-empty">clock bridge spawning…</div>
  {:else if assigned}
    <div class="assigned-row" data-testid="workflow-din-assigned">
      <span class="led on"></span>
      <span class="assigned-name">{assignedDeviceName}</span>
      <button
        class="unassign"
        data-testid="workflow-din-unassign"
        onclick={unassign}
        title="Unassign — TIMELORDE returns to its internal tempo"
        aria-label="Unassign MIDI clock source"
      >✕</button>
    </div>
    <div class="hint">driving TIMELORDE's clock + transport</div>
  {:else if !bridgeState.connected}
    <button class="connect" data-testid="workflow-din-connect" onclick={onConnect}>
      Connect MIDI…
    </button>
    {#if bridgeState.permissionDenied}
      <div class="hint err" data-testid="workflow-din-denied">
        MIDI permission denied or unsupported browser.
      </div>
    {:else}
      <div class="hint">Grant MIDI access to list clock sources (one-time per origin).</div>
    {/if}
  {:else if bridgeState.devices.length === 0}
    <div class="hint" data-testid="workflow-din-no-devices">No MIDI inputs detected.</div>
  {:else}
    <div class="list-header">assign clock source</div>
    {#each bridgeState.devices as d (d.id)}
      <button
        class="device-row"
        data-testid="workflow-din-device"
        data-deviceid={d.id}
        onclick={() => assignDevice(d.id)}
        title={`Use ${d.name} as TIMELORDE's clock source (wires the MIDI clock bridge to CLOCK IN + START + STOP)`}
      >
        <span class="led"></span>
        {d.name}
      </button>
    {/each}
  {/if}
</div>

<style>
  .din-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 230px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .hint {
    font-size: 0.65rem;
    color: var(--text-dim);
    line-height: 1.35;
    padding: 2px 4px;
  }
  .hint.err {
    color: #fca5a5;
  }
  .connect {
    padding: 8px 12px;
    background: var(--cable-gate, #f97316);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.75rem;
    font-family: inherit;
  }
  .connect:hover {
    filter: brightness(1.15);
  }
  .list-header {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    padding: 2px 4px;
  }
  .device-row,
  .assigned-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .device-row {
    cursor: pointer;
  }
  .device-row:hover {
    background: #2a2f3a;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex: 0 0 auto;
  }
  .led.on {
    background: var(--cable-gate, #f97316);
    box-shadow: 0 0 4px var(--cable-gate, #f97316);
  }
  .assigned-name {
    flex: 1;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .unassign {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 1px 7px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7rem;
  }
  .unassign:hover {
    background: #2a2f3a;
    color: var(--text);
  }
</style>
