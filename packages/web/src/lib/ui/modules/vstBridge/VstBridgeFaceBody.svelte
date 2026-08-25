<script lang="ts">
  // VstBridgeFaceBody — the PLUGIN surface at the head of the VST dock full
  // view, shared by `vstInstrument` and `vstFx` exactly as `VstBridgePanel` is
  // shared by their two legacy cards. The only thing that differs between them
  // is which plugin KINDS the picker lists, and that is resolved from the node's
  // own type through the one roster both surfaces import.
  //
  // ── WHY THIS IS A BODY AND NOT A HANDFUL OF CELLS ─────────────────────────
  //
  // Both modules declare `params: []`. Every affordance is `node.data` or a
  // control-plane message, so the face is built entirely from families — and
  // exactly two of them can be generic cells. The rest are here for TWO
  // MEASURED reasons, neither of them taste:
  //
  //   1. **THE PICKER'S ROSTER IS EMPTY ON EVERY CI RUNNER.** It is the user's
  //      installed AU library, enumerated by the helper over a WebSocket, so
  //      with no helper `snap.plugins` is `[]`. `faces-parity`'s selector branch
  //      asserts `expect(n, 'the roster offers options').toBeGreaterThan(1)` and
  //      then picks a DIFFERENT option — a `ShellSelectorCell` here would fail
  //      deterministically on every run. This is the "device picker" gap
  //      `shell-cells.ts` already names in its `ShellCellEnv` note.
  //   2. **THE FILTER IS A PRIVATE VIEW SETTING.** `ShellEntryProbe` requires
  //      the observable to be a `node.data` key, and `node.data` rides the
  //      Y.Doc — shared with every collaborator and saved with the patch. One
  //      player typing "rev" to find their reverb must not re-filter everyone
  //      else's screen or dirty the patch on each keystroke, which is the exact
  //      hazard `ShellPanelProbe`'s `text` note is written about. So the filter
  //      is NOT an `entry` cell; it is component state beside the picker it
  //      narrows, which is also the only place it means anything.
  //
  //   MOUNT / SWAP / UNMOUNT / OPEN EDITOR follow the picker for a third
  //   reason: all four exist ONLY while the helper is connected and a plugin is
  //   selected. A ranked `action` cell must render unconditionally and
  //   `faces-parity` asserts `toBeEnabled()` on it, so a cell that is absent (or
  //   correctly disabled) on a helperless runner cannot be one.
  //
  // ⚠ NO CONNECT BUTTON HERE. Both gestures are RANKED ACTION CELLS in the band
  // below, which is what puts them on the LANE TILE too — the whole point of
  // making them cells, and the same split es9 made. A second button on the same
  // plate would be one gesture with two affordances.
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE EACH FINDING WENT ─────────────
  //
  // `VstBridgePanel` paints three derived rows. None is gone as INFORMATION;
  // all are gone as TEXT, and `vst-status-model.ts` is where they went:
  //
  //   `stateLabel` — a seven-way string switch about the module, painted
  //     outside every control. It is the BRIDGE lamp, with the exact failure
  //     named in `aria-label`. The narrowing (seven states onto two) is stated
  //     in the model rather than hidden.
  //
  //   `in … dB · out … dB · load …% · rtt … ms · latency … smp` — five derived
  //     numbers, i.e. the deleted readout verbatim. The levels and the load
  //     compose into the LOAD lamp's sentence, the round trip into the BRIDGE
  //     lamp's, and the plugin latency into the PLUGIN lamp's.
  //
  //   `state saved in patch · … KB` / `state too large …` — a size and a
  //     warning. It is the SAVED lamp, and the dark half is the one that
  //     matters: an unsaveable blob means the plugin returns EMPTY next load.
  //
  //   `{snap.mounted.plugin.name}` — the card printed the mounted plugin's name
  //     beside the buttons. It is NOT reproduced as a text node: the picker
  //     immediately above already shows the mounted plugin as its own selected
  //     OPTION NAME (a permitted role — it disambiguates the control's own
  //     position), so a second copy would restate a control rather than inform.
  //     The full identity, its maker and its latency are on the PLUGIN lamp.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT, and it SUBSCRIBES rather
  // than polling `vstSnapshot`. `bridge-owner` keeps listeners OUTSIDE the
  // entries precisely so a view may pre-date the connection. `subscribeVst`
  // delivers the current snapshot synchronously, so there is nothing a poll
  // would add.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VstPersisted } from '$lib/audio/vst/vst-persistence';
  import {
    sendVstControl,
    subscribeVst,
    vstSnapshot,
    type VstOwnerSnapshot,
  } from '$lib/audio/vst/bridge-owner';
  import { vstPluginKindsForType } from '$lib/audio/modules/vst-bridge-shared';
  import {
    vstBridgeDetail,
    vstBridgeLit,
    vstLoadDetail,
    vstLoadLit,
    vstPluginDetail,
    vstPluginLit,
    vstSavedDetail,
    vstSavedLit,
  } from './vst-status-model';

  let { nodeId }: { nodeId: string } = $props();

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  let persisted = $derived((node?.data as { vst?: VstPersisted } | undefined)?.vst);
  let kinds = $derived(vstPluginKindsForType(node?.type));

  // svelte-ignore state_referenced_locally -- SEED only. The $effect below
  // re-reads vstSnapshot(nodeId) from the live id and subscribes, so this
  // initial value is replaced before the first paint the user can act on.
  let snap = $state<VstOwnerSnapshot>(vstSnapshot(nodeId));

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const id = nodeId;
    unsubscribe?.();
    unsubscribe = subscribeVst(id, (s) => { snap = s; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  let filter = $state('');
  let selectedId = $state('');
  // Track the mount so the picker follows an adopted instance (a page refresh
  // replays `mounted` before the user touches anything).
  $effect(() => {
    if (snap.mounted && selectedId === '') selectedId = snap.mounted.plugin.id;
  });

  let listed = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    // DEDUPE by id — the wire spec treats plugin ids as opaque and does NOT
    // promise uniqueness. A real AU registry can list one component twice, and
    // the duplicate key throws Svelte's each_key_duplicate and kills the
    // surface (measured against the live helper, on the card).
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

  let linkUp = $derived<boolean>(vstBridgeLit(snap));
  let canSwap = $derived(!!snap.mounted && !!selectedId && selectedId !== snap.mounted.plugin.id);

  function mount(): void {
    if (selectedId) sendVstControl(nodeId, { type: 'mount', pluginId: selectedId });
  }
  function unmount(): void {
    sendVstControl(nodeId, { type: 'unmount' });
  }
  function toggleEditor(): void {
    sendVstControl(nodeId, { type: snap.editorOpen ? 'closeEditor' : 'openEditor' });
  }
</script>

<div class="vst-face-body" data-testid="vst-face-body-{nodeId}">
  {#if !linkUp}
    <!-- INSTRUCTIONAL COPY IN AN EMPTY STATE — the midiclock / es9 shape, and
         permitted by name: the empty state is the whole content of this surface
         before the helper answers, and drawing it rather than leaving a blank is
         what makes "no helper running" and "the body failed to mount" different
         pictures. -->
    {#if !snap.supported}
      <p class="hint" data-testid="vst-unsupported-{nodeId}">
        This browser context has no SharedArrayBuffer. Open the rack from a
        cross-origin-isolated origin.
      </p>
    {:else}
      <p class="hint">Run the vst-bridge helper (Chromium or Firefox), then press Connect.</p>
    {/if}
  {:else}
    <div class="picker-row">
      <input
        class="filter"
        type="text"
        placeholder="filter…"
        aria-label="Filter the plugin list by name or manufacturer"
        bind:value={filter}
        data-testid="vst-face-filter-{nodeId}"
      />
      <select
        bind:value={selectedId}
        aria-label="Which of your installed plugins this card mounts"
        data-testid="vst-face-picker-{nodeId}"
      >
        <option value="" disabled>pick a plugin ({listed.length})</option>
        {#each listed as p (p.id)}
          <option value={p.id}>{p.name} — {p.manufacturer}</option>
        {/each}
      </select>
    </div>
    <div class="actions-row">
      {#if snap.mounted}
        {#if canSwap}
          <button
            class="btn"
            aria-label="Replace the mounted plugin with the one selected above"
            data-testid="vst-face-mount-{nodeId}"
            onclick={mount}
          >swap</button>
        {/if}
        <button
          class="btn"
          aria-label={snap.editorOpen
            ? "Close the plugin's own window on the machine running the helper"
            : "Open the plugin's own window on the machine running the helper"}
          data-testid="vst-face-editor-{nodeId}"
          onclick={toggleEditor}
        >{snap.editorOpen ? 'close editor' : 'open editor'}</button>
        <button
          class="btn"
          aria-label="Unmount the plugin — the bridge passes audio through bit-transparently"
          data-testid="vst-face-unmount-{nodeId}"
          onclick={unmount}
        >unmount</button>
      {:else}
        <button
          class="btn"
          aria-label="Mount the selected plugin into this card"
          data-testid="vst-face-mount-{nodeId}"
          onclick={mount}
          disabled={!selectedId}
        >mount</button>
      {/if}
    </div>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="BRIDGE"
      lit={linkUp}
      detail={vstBridgeDetail(snap)}
      testid="vst-led-bridge-{nodeId}"
    />
    <StatusLed
      caption="PLUGIN"
      lit={vstPluginLit(snap)}
      tone={snap.mountError ? 'warn' : 'accent'}
      detail={vstPluginDetail(snap)}
      testid="vst-led-plugin-{nodeId}"
    />
    <StatusLed
      caption="LOAD"
      lit={vstLoadLit(snap)}
      tone="warn"
      detail={vstLoadDetail(snap)}
      testid="vst-led-load-{nodeId}"
    />
    <StatusLed
      caption="SAVED"
      lit={vstSavedLit(persisted)}
      detail={vstSavedDetail(persisted)}
      testid="vst-led-saved-{nodeId}"
    />
  </span>
</div>

<style>
  .vst-face-body {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
    color: var(--muted, #888);
  }
  .picker-row { display: flex; gap: 4px; align-items: center; }
  .filter {
    width: 72px;
    font-size: 10px;
    background: var(--card-input-bg, #22252b);
    color: inherit;
    border: 1px solid var(--card-input-border, #3a3f4a);
    border-radius: 3px;
    padding: 1px 4px;
  }
  select {
    max-width: 220px;
    min-width: 0;
    font-size: 10px;
    background: var(--card-input-bg, #22252b);
    color: inherit;
    border: 1px solid var(--card-input-border, #3a3f4a);
    border-radius: 3px;
  }
  .actions-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .btn {
    font-size: 10px;
    background: var(--card-input-bg, #22252b);
    color: inherit;
    border: 1px solid var(--card-input-border, #3a3f4a);
    border-radius: 3px;
    cursor: pointer;
    padding: 1px 6px;
  }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
