<script lang="ts">
  // MidiclockDeviceBody — the DEVICE BINDING surface, at the head of the dock
  // full view.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE DEVICE `<select>` — the one affordance on this module that cannot
  //     be a face cell. Its roster lives on the engine handle behind
  //     `requestMIDIAccess()` and differs per machine, so it is neither a
  //     `ParamDef` nor an `options` roster (a roster is a fixed set known when
  //     the def is authored). Its painted text is the DEVICE NAME, which is a
  //     NAME — the cameraInput precedent, made for exactly this problem.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the measurement in `aria-label` / `title`.
  //     Nothing about their state reaches a text node.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the
  //     empty state is the whole content of the plate before a grant.
  //   * THE ACCESS FAILURE — an ERROR, absent whenever nothing is wrong. ⚠ AND
  //     IT STAYS LOUD. The legacy card's comment is the reason and it is worth
  //     carrying: "The old copy was a one-line hint swap that a user reading a
  //     dead button did not register — and the suppressed-prompt case produced
  //     NO message at all." It comes from the shared `midiOutcomeMessage` seam,
  //     which always yields a nameable outcome including the case where the
  //     browser silently declined to show a prompt.
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE THE FINDING WENT ───────────────
  //
  // The legacy card painted two readout rows and BOTH are gone:
  //
  //   `STATE — RUN / STOP` was a state word about the module, the deleted hero
  //     readout strip's exact shape. It carried a REAL finding, and the finding
  //     survives: this is the only place in the entire product that says
  //     whether the EXTERNAL transport is running, and it is not redundant with
  //     TIMELORDE's own transport — the whole point of this module is that
  //     something outside the browser is the boss, and `run` is a level a
  //     player may not have patched anywhere visible. It is now the RUN LAMP: a
  //     picture, lit or dark, with the sentence in `aria-label`. `notify()`
  //     fires on exactly START / CONTINUE / STOP, so a subscriber-driven lamp
  //     is live and correct here.
  //
  //   `TICKS — n` was a raw count, which may not paint. ⚠ AND IT IS NOT MOVED
  //     TO AN ARIA ATTRIBUTE EITHER, DELIBERATELY. The module's CLOCK branch
  //     returns before `notify()` — correctly, since 24 PPQN at 120 BPM is
  //     48 Hz of subscriber pressure — so a pushed tick count is the value as
  //     of the last transport message and freezes for the whole performance.
  //     The card painted exactly that and called it a "live activity
  //     indicator". Putting a frozen number in `aria-label` would be the same
  //     lie one layer down, so the count is simply not on this surface;
  //     `getState().ticksReceived` remains a live on-demand read for tests.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT. The `$effect` teardown
  // plus `onDestroy` is the card's pattern, and a body that subscribed without
  // unsubscribing is the node-resource-leak class from the other side.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { MidiclockCardState } from '$lib/audio/modules/midiclock';
  import { nameOfDevice } from '$lib/graph/device-rebind';
  import { midiclockApi } from '../midiclock-cell-actions';
  import {
    midiclockDeviceDetail,
    midiclockTransportDetail,
    midiclockDeviceName,
  } from './midiclock-status-model';

  let { nodeId }: { nodeId: string } = $props();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  let cardState = $state<MidiclockCardState>({
    connected: false,
    permissionDenied: false,
    accessMessage: '',
    devices: [],
    selectedDeviceId: null,
    running: false,
    divisor: 24,
    ticksReceived: 0,
  });

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = nodeId;
    void node;
    const api = midiclockApi(nodeId);
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe((s) => { cardState = s; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  function onChangeDevice(ev: Event): void {
    const sel = (ev.currentTarget as HTMLSelectElement).value || null;
    midiclockApi(nodeId)?.selectDevice(sel);
    // ⚠ ORIGIN-TAGGED. The legacy card wrote this key with a bare SyncedStore
    // proxy write — no `transact`, no `LOCAL_ORIGIN` — so picking a device
    // synced to collaborators but never reached the UndoManager, i.e. it was
    // silently outside Cmd-Z. `mutateNode` is the sanctioned seam.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      // ⚠ THE NAME IS WRITTEN AT PICK TIME because it is the only moment it is
      // knowable. `lastDeviceId` is the MIDIPort.id, which the spec leaves
      // implementation-defined — this file's own bundle exporter calls it
      // "unstable" — so on a later load the id may name nothing, and the
      // remembered name is what still identifies the hardware.
      live.data.lastDeviceId = sel;
      const nm = nameOfDevice(sel, cardState.devices);
      if (nm) live.data.lastDeviceName = nm;
      else delete live.data.lastDeviceName;
    });
  }

  // Every STRING this surface can produce — including the ones that are never
  // painted — comes from the pure model beside this file. An unpainted string
  // that is wrong is invisible to a VRT baseline and to a human reading one, so
  // they are decided where a unit test can read them.
  let deviceDetail = $derived<string>(midiclockDeviceDetail(cardState));
  let transportDetail = $derived<string>(midiclockTransportDetail(cardState));
</script>

<div class="midiclock-device" data-testid="midiclock-device-body-{nodeId}">
  {#if !cardState.connected}
    <!-- ⚠ NO CONNECT BUTTON HERE, DELIBERATELY. The gesture is a RANKED ACTION
         CELL in the band below, which is what puts it on the lane tile too —
         the whole point of making it a cell rather than a body control. A
         second button on the same plate would be one gesture with two
         affordances, which is clutter under "compact is the default" and, worse,
         a second thing to keep in sync. This branch is the EMPTY STATE: what to
         do, and why nothing is listed yet. -->
    {#if cardState.accessMessage}
      <p class="err" data-testid="midiclock-access-error-{nodeId}">{cardState.accessMessage}</p>
    {:else}
      <p class="hint">Press Connect MIDI to grant access and pick a device. One-time per origin.</p>
    {/if}
  {:else}
    <label class="row">
      <span class="cap">Device</span>
      <select
        data-testid="midiclock-device-select-{nodeId}"
        onchange={onChangeDevice}
        value={cardState.selectedDeviceId ?? ''}
      >
        <option value="" disabled>(pick one)</option>
        {#each cardState.devices as d (d.id)}
          <option value={d.id}>{midiclockDeviceName(d)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="MIDI"
      lit={cardState.connected}
      detail={deviceDetail}
      testid="midiclock-led-midi-{nodeId}"
    />
    <StatusLed
      caption="RUN"
      lit={cardState.running}
      detail={transportDetail}
      testid="midiclock-led-run-{nodeId}"
    />
  </span>
</div>

<style>
  .midiclock-device {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
  }
  .hint { color: var(--muted, #888); }
  .err { color: #d66; }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  /* A control CAPTION, typeset the way every other cell caption is. */
  .row .cap {
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    font-size: 9px;
  }
  .row select {
    font-size: 10px;
    padding: 2px 4px;
    max-width: 190px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
