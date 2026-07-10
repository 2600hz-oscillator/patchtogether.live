<script lang="ts">
  // ES-9 card — owns the native-bridge CONNECTION lifecycle (worker + SAB
  // rings via Es9BridgeClient), mirroring how AudioinCard owns its
  // MediaStream: the engine factory stays DOM-free and gets the ring specs
  // through the __es9Attach handle hook. Class selectors are ordinary
  // discrete params (Yjs-synced); the factory forwards them to the worklet
  // and this card forwards the derived hold/fade modes to the bridge.
  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode, PortDef } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';
  import {
    es9Def,
    es9Attach,
    es9OutputModes,
    ES9_CLASS_NAMES,
  } from '$lib/audio/modules/es9';
  import { Es9BridgeClient, type Es9ConnectionState } from '$lib/audio/es9/bridge-client';
  import type { Es9DeviceInfo, Es9Meters } from '$lib/audio/es9/es9-protocol';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, engineCtx } = cardParams(es9Def, () => id, () => node);

  // ---- per-tab transient state (never in Yjs) ----
  let connState = $state<Es9ConnectionState>('idle');
  let stateDetail = $state<string | undefined>(undefined);
  let device = $state<Es9DeviceInfo | null>(null);
  let meters = $state<Es9Meters | null>(null);
  let rtt = $state<number | null>(null);
  let client: Es9BridgeClient | null = null;
  let attachTimer: ReturnType<typeof setInterval> | null = null;

  const IN_JACKS = Array.from({ length: 14 }, (_, i) => i + 1);
  const OUT_JACKS = Array.from({ length: 8 }, (_, i) => i + 1);

  function classVal(paramId: string, fallback: number): number {
    const v = node?.params?.[paramId];
    return typeof v === 'number' ? v : fallback;
  }

  function currentConfig() {
    return {
      // v1 subscribes/drives all channels — loopback bandwidth is trivial
      // (~3 MB/s) and it keeps masks decoupled from patch-edge churn.
      // TODO(follow-up): derive masks from patched edges.
      inputChannels: Array.from({ length: 16 }, (_, c) => c),
      outputChannels: Array.from({ length: 16 }, (_, c) => c),
      outputModes: es9OutputModes(node?.params),
    };
  }

  function connect(): void {
    if (client) return;
    client = new Es9BridgeClient({
      onState: (s, detail) => {
        connState = s;
        stateDetail = detail;
        if (s !== 'connected') { device = null; rtt = null; }
      },
      onDeviceInfo: (info) => { device = info; },
      onMeters: (m) => { meters = m; },
      onRtt: (ms) => { rtt = ms; },
    });
    if (!client.supported) return;
    const engine = engineCtx.get();
    const audioEngine = engine?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
    const rate = audioEngine?.ctx?.sampleRate ?? 48000;
    client.start(rate, currentConfig());
    // Hand the rings to the engine node; retry across the Yjs→engine
    // reconcile race (audioin's card does the same dance for its stream).
    const payload = { inRing: client.inRing, outRing: client.outRing };
    if (!es9Attach(engine, id, payload)) {
      attachTimer = setInterval(() => {
        if (es9Attach(engineCtx.get(), id, payload)) {
          clearInterval(attachTimer!);
          attachTimer = null;
        }
      }, 250);
    }
  }

  function disconnect(): void {
    if (attachTimer !== null) { clearInterval(attachTimer); attachTimer = null; }
    es9Attach(engineCtx.get(), id, null);
    client?.stop();
    client = null;
    connState = 'idle';
    device = null;
    meters = null;
    rtt = null;
  }

  function setClass(paramId: string) {
    return (e: Event) => {
      const v = Number((e.currentTarget as HTMLSelectElement).value);
      set(paramId)(v);
      // Bridge-side hold/fade policy follows the out-jack classes.
      client?.updateConfig(currentConfig());
    };
  }

  // Probe once when the card first mounts (module spawn / patch load with
  // the module present) — never on plain page load without the module.
  $effect(() => {
    if (!client && connState === 'idle') connect();
  });
  onDestroy(disconnect);

  // ---- patch panel sections ----
  function toDescriptor(p: PortDef): PortDescriptor {
    return { id: p.id, cable: p.type };
  }
  const inputById = new Map(es9Def.inputs.map((p) => [p.id, toDescriptor(p)] as const));
  const outputById = new Map(es9Def.outputs.map((p) => [p.id, toDescriptor(p)] as const));
  const pick = (m: Map<string, PortDescriptor>, ids: string[]) =>
    ids.map((pid) => m.get(pid)).filter((p): p is PortDescriptor => p !== undefined);

  const sections = [
    {
      label: 'IN 1–7',
      outputs: pick(outputById, IN_JACKS.slice(0, 7).flatMap((n) => [`in${n}`, `in${n}_cv`])),
    },
    {
      label: 'IN 8–14',
      outputs: pick(outputById, IN_JACKS.slice(7).flatMap((n) => [`in${n}`, `in${n}_cv`])),
    },
    { label: 'S/PDIF', outputs: pick(outputById, ['spdif_l', 'spdif_r']) },
    // Physical jacks (USB 9-16 under the ES-9's default routing).
    { label: 'OUT 1–8 (jacks)', inputs: pick(inputById, OUT_JACKS.map((n) => `out${n}`)) },
    // USB 1-8: internal mixer (main/phones), S/PDIF out, ES-5 header.
    { label: 'USB 1–8 (mix/S-PDIF/ES-5)', inputs: pick(inputById, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `usb${n}`)) },
  ];

  const stateLabel = $derived.by(() => {
    switch (connState) {
      case 'connected': return device ? device.name : 'connected';
      case 'connecting': return 'connecting…';
      case 'busy': return 'bridge busy (another client)';
      case 'device_lost': return 'ES-9 unplugged';
      case 'unsupported': return 'needs cross-origin isolation';
      case 'stopped': case 'idle': return 'off';
      default: return 'bridge not found';
    }
  });
</script>

<div class="mod-card es9-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="ES-9" inline />
  </header>

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={520}>
    <div class="body">
      <div class="status-row" data-testid="es9-status-{id}">
        <span class="led" class:on={connState === 'connected'} class:err={connState === 'busy' || connState === 'device_lost'}></span>
        <span class="state">{stateLabel}</span>
        {#if connState === 'connected'}
          <button class="linkish" onclick={disconnect}>disconnect</button>
        {:else if connState !== 'connecting' && connState !== 'unsupported'}
          <button class="linkish" onclick={() => { disconnect(); connect(); }}>connect</button>
        {/if}
      </div>
      {#if connState === 'connected' && device}
        <div class="detail">
          {device.rate / 1000} kHz · {device.inputChannels}×{device.outputChannels}
          {#if rtt !== null}· rtt {rtt.toFixed(1)} ms{/if}
          {#if meters}· xruns {meters.underruns}/{meters.overruns}{/if}
        </div>
      {:else if connState === 'unsupported'}
        <div class="detail">SharedArrayBuffer unavailable in this context.</div>
      {:else if connState !== 'connected'}
        <div class="detail">Run the es9-bridge app (Chromium required), then connect.</div>
      {/if}

      <div class="classes">
        <div class="col">
          <div class="col-label">IN class (cv twin)</div>
          {#each IN_JACKS as n (n)}
            <label class="row">
              <span class="jack">{n}</span>
              <select
                data-testid="es9-inclass-{id}-{n}"
                value={String(classVal(`in${n}_class`, 1))}
                onchange={setClass(`in${n}_class`)}
              >
                {#each ES9_CLASS_NAMES as name, v (name)}
                  <option value={String(v)}>{name}</option>
                {/each}
              </select>
            </label>
          {/each}
        </div>
        <div class="col">
          <div class="col-label">OUT class</div>
          {#each OUT_JACKS as n (n)}
            <label class="row">
              <span class="jack">{n}</span>
              <select
                data-testid="es9-outclass-{id}-{n}"
                value={String(classVal(`out${n}_class`, 0))}
                onchange={setClass(`out${n}_class`)}
              >
                {#each ES9_CLASS_NAMES as name, v (name)}
                  <option value={String(v)}>{name}</option>
                {/each}
              </select>
            </label>
          {/each}
          <div class="hint">±1.0 ≙ ±10 V at the jacks</div>
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .es9-card { position: relative; }
  .stripe { position: absolute; inset: 0 auto 0 0; width: 4px; border-radius: 2px 0 0 2px; }
  .title { display: flex; align-items: center; gap: 6px; padding: 2px 4px 4px 8px; }
  .body { display: flex; flex-direction: column; gap: 6px; padding: 2px 6px 6px 10px; min-width: 210px; }
  .status-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .led { width: 8px; height: 8px; border-radius: 50%; background: #555; flex: none; }
  .led.on { background: #4ade80; }
  .led.err { background: #f87171; }
  .state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .linkish { background: none; border: none; color: var(--accent, #93c5fd); cursor: pointer; font-size: 10px; padding: 0; text-decoration: underline; }
  .detail { font-size: 10px; opacity: 0.7; }
  .classes { display: flex; gap: 10px; }
  .col { display: flex; flex-direction: column; gap: 2px; }
  .col-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin-bottom: 2px; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 10px; }
  .jack { width: 14px; text-align: right; opacity: 0.7; }
  select { font-size: 10px; background: var(--card-input-bg, #22252b); color: inherit; border: 1px solid var(--card-input-border, #3a3f4a); border-radius: 3px; }
  .hint { font-size: 9px; opacity: 0.5; margin-top: 4px; }
</style>
