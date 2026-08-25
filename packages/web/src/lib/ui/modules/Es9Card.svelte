<script lang="ts">
  // ES-9 card — a VIEW over the bridge, which it no longer owns.
  //
  // It used to construct the Es9BridgeClient on mount and `disconnect()` on
  // destroy, which made the live hardware stream's lifetime the lifetime of a
  // Svelte component: collapsing the dock pane, or a lane that renders a
  // compact tile instead of the card, KILLED the stream (owner report
  // 2026-08-05). Ownership now lives on the ENGINE NODE — see
  // $lib/audio/es9/bridge-owner — so the connection lasts as long as the node
  // is in the graph. This card only SUBSCRIBES; unsubscribing on unmount
  // touches nothing but the listener set.
  //
  // Class selectors are ordinary discrete params (Yjs-synced); the ENGINE
  // FACTORY forwards them to the worklet AND pushes the derived hold/fade
  // modes to the live connection.
  //
  // ⚠ THIS CARD USED TO OWN THE SECOND HALF OF THAT, AND IT WAS A LIVE DEFECT.
  // `setClass` called `updateEs9Config` itself, and it was the only caller in
  // the tree — on a card the default shell has not mounted in a lane since
  // ownership moved to the engine node, so on the renderer every user actually
  // gets, the native app's per-jack UNDERRUN POLICY never followed the class
  // param. Worse, the CV-Buddy janitor writes `out{N}_class` straight through
  // the store and touches no card at all, so its writes could never reach it.
  // The push is now in `es9Def`'s `setParam`, which is the one place that sees
  // a class change with no view involved. This card sets the param and nothing
  // else, so the two surfaces cannot disagree about the policy.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode, PortDef } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';
  import {
    es9Def,
    es9BridgeConfig,
    ES9_CLASS_NAMES,
  } from '$lib/audio/modules/es9';
  import type { Es9ConnectionState } from '$lib/audio/es9/bridge-client';
  import {
    es9Snapshot,
    subscribeEs9,
    stopEs9Bridge,
    restartEs9Bridge,
    type Es9OwnerSnapshot,
  } from '$lib/audio/es9/bridge-owner';
  import type { Es9DeviceInfo, Es9Meters } from '$lib/audio/es9/es9-protocol';
  import { patch } from '$lib/graph/store';
  import { nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { allocateCvBuddySlots , type CvBuddyInstance } from '$lib/audio/cv-buddy/slot-alloc';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, engineCtx } = cardParams(es9Def, () => id, () => node);

  // ---- per-tab transient state (never in Yjs) — MIRRORED from the owner ----
  //
  // ⚠ `snap.detail` IS NOT DERIVED HERE ANY MORE, AND ITS ABSENCE IS THE POINT.
  // This file used to compute `stateDetail = snap.detail` and then never read
  // it in any template branch — the bridge worker sends a real detail string on
  // every status message and the card threw the most specific thing it knew
  // straight away. It has a consumer now, on the FACEPLATE: `es9BridgeDetail`
  // composes it into the BRIDGE lamp's `aria-label`, which is where the
  // resting-text ruling sends a measurement.
  // svelte-ignore state_referenced_locally -- SEED only. The $effect below re-reads
  // es9Snapshot(nodeId) from the live id and subscribes, so this initial value is
  // replaced before the first paint that could show a stale one.
  let snap = $state<Es9OwnerSnapshot>(es9Snapshot(id));
  let connState = $derived<Es9ConnectionState>(snap.state);
  let device = $derived<Es9DeviceInfo | null>(snap.device);
  let meters = $derived<Es9Meters | null>(snap.meters);
  let rtt = $derived<number | null>(snap.rtt);

  const IN_JACKS = Array.from({ length: 14 }, (_, i) => i + 1);
  const OUT_JACKS = Array.from({ length: 8 }, (_, i) => i + 1);

  function classVal(paramId: string, fallback: number): number {
    const v = node?.params?.[paramId];
    return typeof v === 'number' ? v : fallback;
  }

  // ⚠ IMPORTED FROM THE DEF, NOT REBUILT HERE. This used to be a second
  // hand-written copy of the config shape beside the factory's, which is
  // exactly how the two ended up meaning different things; `es9BridgeConfig`
  // is the one builder and its TODO about deriving masks from patched edges
  // lives with it rather than in two places.
  function currentConfig() {
    return es9BridgeConfig(node?.params);
  }

  /** The engine's AudioContext rate — the bridge must be restarted at the SAME
   *  rate the worklet runs at, or the ring would be resampled by accident. */
  function sampleRate(): number {
    const e = engineCtx.get();
    const audio = e?.getDomain?.('audio') as { ctx?: AudioContext } | undefined;
    return audio?.ctx?.sampleRate ?? 48000;
  }

  function setClass(paramId: string) {
    return (e: Event) => {
      const v = Number((e.currentTarget as HTMLSelectElement).value);
      // The param write is the WHOLE gesture. The engine handle's `setParam`
      // pushes both the worklet's class array and the bridge's hold/fade
      // policy — see the header.
      set(paramId)(v);
    };
  }

  // SUBSCRIBE ONLY. No connect on mount, no disconnect on destroy — the engine
  // node owns the connection, so this card can mount and unmount freely (dock
  // collapse, shell tile swap, expand) without touching the hardware stream.
  // Re-subscribes if the node id changes; the returned cleanup removes just the
  // listener.
  $effect(() => {
    const nodeId = id;
    snap = es9Snapshot(nodeId);
    return subscribeEs9(nodeId, (s) => { snap = s; });
  });

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

  // Which physical output jacks a CV Buddy is currently auto-driving (reactive
  // over node add/remove). Purely informational; the CV-Buddy↔ES-9 reconciler
  // owns the actual edges + class params.
  let cvbStructuralV = $derived(nodesStructuralVersion());
  let cvBuddyJacks = $derived.by<string>(() => {
    void cvbStructuralV;
    const insts: CvBuddyInstance[] = [];
    for (const n of Object.values(patch.nodes)) {
      const t = (n as { type?: string } | undefined)?.type;
      if (t === 'cvBuddy') insts.push({ id: (n as { id: string }).id, kind: 'full' });
      else if (t === 'cvBuddyMini') insts.push({ id: (n as { id: string }).id, kind: 'mini' });
    }
    const slots = new Set<number>();
    for (const a of allocateCvBuddySlots(insts).values()) {
      slots.add(a.pitchSlot); slots.add(a.gateSlot);
      if (a.velSlot != null) slots.add(a.velSlot); // MINI has none
      if (a.runSlot != null) slots.add(a.runSlot);
      if (a.clockSlot != null) slots.add(a.clockSlot);
    }
    if (slots.size === 0) return '';
    return [...slots]
      .sort((x, y) => x - y)
      .map((s) => (s === 7 ? '7 (run)' : s === 8 ? '8 (clock)' : String(s)))
      .join(', ');
  });

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
        <!-- The testids are what `module-docs-lint`'s card-drift leg reads for
             the `es9-connect` / `es9-disconnect` controlFamilies the face
             declares — and they also repair a live weakness in
             es9-card-shows-state.spec.ts, which found these buttons by their
             VISIBLE TEXT and so was one caption edit away from unfindable. -->
        {#if connState === 'connected'}
          <button class="linkish" data-testid="es9-disconnect-{id}" onclick={() => stopEs9Bridge(id)}>disconnect</button>
        {:else if connState !== 'connecting' && connState !== 'unsupported'}
          <button class="linkish" data-testid="es9-connect-{id}" onclick={() => restartEs9Bridge(id, sampleRate(), currentConfig())}>connect</button>
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
      {#if cvBuddyJacks}
        <div class="detail cvb" data-testid="es9-cvbuddy-{id}">Jacks driven by CV Buddy: {cvBuddyJacks}</div>
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
