<script lang="ts">
  // VstBridgePanel — the shared card BODY for VstInstrumentCard / VstFxCard:
  // connection pill, plugin picker (filtered by kind + text), mount/unmount,
  // OPEN EDITOR (raises the plugin's native window on the helper's machine),
  // meters (in/out dBFS, plugin load), rtt + plugin latency readouts.
  //
  // A VIEW over the bridge, never its owner (the es9 lesson): the engine
  // node owns the connection via $lib/audio/vst/bridge-owner; this panel
  // only SUBSCRIBES and sends control messages. Mount/unmount of the card
  // never touches the socket.
  import { onMount } from 'svelte';
  import type { VstPluginKind } from '$lib/audio/vst/vst-protocol';
  import type { VstConnectionState } from '$lib/audio/vst/bridge-client';
  import type { VstPersisted } from '$lib/audio/vst/vst-persistence';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    restartVstBridge,
    sendVstControl,
    stopVstBridge,
    subscribeVst,
    vstSnapshot,
    type VstOwnerSnapshot,
  } from '$lib/audio/vst/bridge-owner';

  let {
    id,
    node,
    kinds,
    sendPlanes,
    sampleRate,
  }: {
    /** The graph node id (= the helper-side clientId). */
    id: string;
    /** The live graph node — the persisted `data.vst` record renders the
     *  state-size indicator / too-large warning. */
    node: ModuleNode | undefined;
    /** Plugin kinds this card lists in its picker. */
    kinds: readonly VstPluginKind[];
    /** This card's transport mode (fx sends audio planes; instrument sends
     *  clock blocks) — lets CONNECT create the connection when the engine
     *  entry does not exist yet (the es9 dead-button lesson). */
    sendPlanes: boolean;
    /** The engine AudioContext rate — a reconnect must hello at the SAME
     *  rate the worklet runs at (the bridge renders at hello.rate). */
    sampleRate: () => number;
  } = $props();

  let persisted = $derived((node?.data as { vst?: VstPersisted } | undefined)?.vst);

  // svelte-ignore state_referenced_locally -- SEED only; onMount re-reads
  // vstSnapshot(id) and subscribes, replacing this before first paint the
  // user can act on.
  let snap = $state<VstOwnerSnapshot>(vstSnapshot(id));
  let connState = $derived<VstConnectionState>(snap.state);

  // SUBSCRIBE IN onMount, NOT $effect. The es9-style
  // `$effect(() => { snap = …; return subscribe(...) })` form is one
  // tracked read away from an infinite loop: the subscription's SYNCHRONOUS
  // first delivery writes `snap` inside the still-tracking effect, so any
  // read of `snap` that later creeps into the effect body re-triggers it
  // until effect_update_depth_exceeded aborts the whole flush — taking the
  // canvas reconciler's effects down with it (measured while debugging
  // #1953: one added log line reading snap.state produced exactly that).
  // onMount runs once, outside tracking; a card's node id never changes
  // while mounted (xyflow remounts on id change), so the
  // re-subscribe-on-id-change generality is not needed.
  onMount(() => {
    snap = vstSnapshot(id);
    return subscribeVst(id, (s) => { snap = s; });
  });

  let filter = $state('');
  let selectedId = $state('');
  // Track the mount so the picker follows an adopted instance (page refresh
  // replays `mounted` before the user touches anything).
  $effect(() => {
    if (snap.mounted && selectedId === '') selectedId = snap.mounted.plugin.id;
  });

  let listed = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    // DEDUPE by id: the wire spec treats plugin ids as opaque and does NOT
    // promise uniqueness — a real AU registry can list one component twice
    // (measured against the live helper: the duplicate key threw Svelte's
    // each_key_duplicate and killed the card). First occurrence wins; two
    // options with the same value would be redundant in a <select> anyway.
    const seen = new Set<string>();
    const out: typeof snap.plugins = [];
    for (const p of snap.plugins) {
      if (!(kinds as readonly string[]).includes(p.kind)) continue;
      if (q !== '' && !p.name.toLowerCase().includes(q) && !p.manufacturer.toLowerCase().includes(q)) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out;
  });

  const stateLabel = $derived.by(() => {
    switch (connState) {
      case 'connected': return snap.helper ? `${snap.helper.name} v${snap.helper.version}` : 'connected';
      case 'connecting': return 'connecting…';
      case 'busy': return 'helper full (16 plugins)';
      case 'evicted': return 'claimed by another tab';
      case 'unsupported': return 'needs cross-origin isolation';
      case 'stopped': case 'idle': return 'off';
      default: return 'helper not found';
    }
  });

  /** Peak of the per-channel dBFS pairs, floored for display. */
  function db(v: number[] | undefined): string {
    if (!v || v.length === 0) return '−∞';
    const m = Math.max(...v);
    return m <= -120 ? '−∞' : m.toFixed(0);
  }

  function mount(): void {
    if (selectedId) sendVstControl(id, { type: 'mount', pluginId: selectedId });
  }
  function unmount(): void {
    sendVstControl(id, { type: 'unmount' });
  }
  function toggleEditor(): void {
    sendVstControl(id, { type: snap.editorOpen ? 'closeEditor' : 'openEditor' });
  }
</script>

<div class="vst-body">
  <div class="status-row" data-testid="vst-status-{id}">
    <span class="led" class:on={connState === 'connected'} class:err={connState === 'busy' || connState === 'evicted'}></span>
    <span class="state">{stateLabel}</span>
    {#if connState === 'connected'}
      <button class="linkish" onclick={() => stopVstBridge(id)}>disconnect</button>
    {:else if connState !== 'connecting' && connState !== 'unsupported'}
      <button class="linkish" data-testid="vst-connect-{id}" onclick={() => restartVstBridge(id, sampleRate(), { clientId: id, sendPlanes })}>connect</button>
    {/if}
  </div>

  {#if connState === 'unsupported'}
    <div class="detail">SharedArrayBuffer unavailable in this context.</div>
  {:else if connState === 'evicted'}
    <div class="detail">Another tab took this card's plugin instance — connect to reclaim it.</div>
  {:else if connState !== 'connected'}
    <div class="detail">Run the vst-bridge helper (Chromium/Firefox), then connect.</div>
  {/if}

  {#if connState === 'connected'}
    <div class="picker-row">
      <input
        class="filter"
        type="text"
        placeholder="filter…"
        bind:value={filter}
        data-testid="vst-filter-{id}"
      />
      <select bind:value={selectedId} data-testid="vst-picker-{id}">
        <option value="" disabled>pick a plugin ({listed.length})</option>
        {#each listed as p (p.id)}
          <option value={p.id}>{p.name} — {p.manufacturer}</option>
        {/each}
      </select>
    </div>
    <div class="actions-row">
      {#if snap.mounted}
        <span class="mounted" data-testid="vst-mounted-{id}">{snap.mounted.plugin.name}</span>
        {#if selectedId && selectedId !== snap.mounted.plugin.id}
          <button class="btn" data-testid="vst-mount-{id}" onclick={mount}>swap</button>
        {/if}
        <button class="btn" data-testid="vst-editor-{id}" onclick={toggleEditor}>
          {snap.editorOpen ? 'close editor' : 'open editor'}
        </button>
        <button class="btn" data-testid="vst-unmount-{id}" onclick={unmount}>unmount</button>
      {:else}
        <button class="btn" data-testid="vst-mount-{id}" onclick={mount} disabled={!selectedId}>mount</button>
      {/if}
    </div>
    {#if snap.mountError}
      <div class="detail err" data-testid="vst-mount-error-{id}">
        {snap.mountError.pluginId}: {snap.mountError.message}
      </div>
    {/if}
    <div class="detail" data-testid="vst-meters-{id}">
      {#if snap.meters}
        in {db(snap.meters.inputRMS)} dB · out {db(snap.meters.outputRMS)} dB · load {snap.meters.loadPct.toFixed(0)}%
      {/if}
      {#if snap.rtt !== null}· rtt {snap.rtt.toFixed(1)} ms{/if}
      {#if snap.mounted}· latency {snap.mounted.latencySamples} smp{/if}
    </div>
    {#if persisted?.stateBytes !== undefined}
      <div class="detail" data-testid="vst-state-size-{id}">
        {#if persisted.stateB64 !== undefined}
          state saved in patch · {(persisted.stateBytes / 1024).toFixed(1)} KB
        {:else}
          state too large to keep in the patch ({(persisted.stateBytes / 1024).toFixed(0)} KB) — plugin id only; save presets in the plugin
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .vst-body { display: flex; flex-direction: column; gap: 5px; padding: 2px 6px 6px 10px; min-width: 200px; }
  .status-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .led { width: 8px; height: 8px; border-radius: 50%; background: #555; flex: none; }
  .led.on { background: #4ade80; }
  .led.err { background: #f87171; }
  .state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .linkish { background: none; border: none; color: var(--accent, #93c5fd); cursor: pointer; font-size: 10px; padding: 0; text-decoration: underline; }
  .detail { font-size: 10px; opacity: 0.7; }
  .detail.err { color: #f87171; opacity: 1; }
  .picker-row { display: flex; gap: 4px; align-items: center; }
  .filter { width: 64px; font-size: 10px; background: var(--card-input-bg, #22252b); color: inherit; border: 1px solid var(--card-input-border, #3a3f4a); border-radius: 3px; padding: 1px 4px; }
  select { flex: 1; min-width: 0; font-size: 10px; background: var(--card-input-bg, #22252b); color: inherit; border: 1px solid var(--card-input-border, #3a3f4a); border-radius: 3px; }
  .actions-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .mounted { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { font-size: 10px; background: var(--card-input-bg, #22252b); color: inherit; border: 1px solid var(--card-input-border, #3a3f4a); border-radius: 3px; cursor: pointer; padding: 1px 6px; }
  .btn:disabled { opacity: 0.4; cursor: default; }
</style>
