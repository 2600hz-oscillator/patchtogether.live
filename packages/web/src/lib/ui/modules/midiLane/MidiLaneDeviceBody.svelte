<script lang="ts">
  // MidiLaneDeviceBody — the DEVICE BINDING strip at the head of the MIDI LANE
  // dock full view.
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
  //   * THE FOUR LAMPS, through `StatusLed`: a static literal caption, a
  //     boolean that IS the picture, and the measurement in `aria-label` /
  //     `title`. Nothing about their state reaches a text node.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the
  //     empty state is the whole content of the strip before a grant.
  //   * THE ACCESS FAILURE — an ERROR, absent whenever nothing is wrong.
  //
  // ⚠ NO CONNECT BUTTON HERE. The gesture is a RANKED ACTION CELL in the band
  // below, which is what puts it on the LANE TILE too — the whole point of
  // making it a cell. A second button on the same plate would be one gesture
  // with two affordances.
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE EACH FINDING WENT ──────────────
  //
  // The legacy card painted a two-row readout and a per-tap number, and all
  // three are gone as TEXT. None of them is gone as INFORMATION:
  //
  //   `NOTE — C5` / `VEL — 100` were a value and a measurement, the deleted
  //     hero-readout strip's exact shape. They carried a real finding: this is
  //     the only place in the product that says whether the lane is RECEIVING —
  //     a lane pointed at the wrong channel is silent, and silence is also what
  //     a correctly-bound lane looks like between notes. It is now the NOTE
  //     LAMP: a picture, lit while keys are held, with the note and velocity in
  //     `aria-label`.
  //
  //     ⚠ AND THE LAMP NEEDED A NEW ENGINE FIELD, which is the part worth
  //     recording. The obvious binding is `lastNote !== null` and it is WRONG:
  //     `lastNote` is assigned on note-on and never cleared, so that lamp
  //     lights once and never goes dark. `heldCount` was added to
  //     `MidiLaneCardState` for this — see the field's own comment.
  //
  //   `CC A — 1` / `CC B — —` were the bound controller numbers. A number under
  //     a control is the readout the ruling deletes, and there is nowhere on a
  //     faceplate for it. They are the two CC LAMPS: lit when a tap is bound OR
  //     armed, with "following controller 1, last value 64" in `aria-label`.
  //     That is strictly MORE than the card said, because the card never showed
  //     the value the tap was receiving.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT. The `$effect` teardown
  // plus `onDestroy` is the card's own pattern; a body that subscribed without
  // unsubscribing is the node-resource-leak class from the other side.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { MidiLaneCardState } from '$lib/audio/modules/midi-lane';
  import { midiLaneApi } from '../midi-lane-cell-actions';
  import {
    midiLaneCcDetail,
    midiLaneCcLit,
    midiLaneDeviceDetail,
    midiLaneDeviceName,
    midiLaneNoteDetail,
  } from './midi-lane-status-model';

  let { nodeId }: { nodeId: string } = $props();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  let cardState = $state<MidiLaneCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    lastNote: null,
    lastVelocity: 0,
    heldCount: 0,
    lastCcA: null,
    lastCcB: null,
    ccANum: null,
    ccBNum: null,
    learningCcA: false,
    learningCcB: false,
  });

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = nodeId;
    void node;
    const api = midiLaneApi(nodeId);
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
    midiLaneApi(nodeId)?.selectDevice(sel);
    // ⚠ ORIGIN-TAGGED. The legacy card writes this key with a bare SyncedStore
    // proxy write — no `transact`, no `LOCAL_ORIGIN` — so picking a device
    // synced to collaborators but never reached the UndoManager. `mutateNode`
    // is the sanctioned seam.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.lastDeviceId = sel;
    });
  }

  let deviceDetail = $derived<string>(midiLaneDeviceDetail(cardState));
  let noteDetail = $derived<string>(midiLaneNoteDetail(cardState));
  let ccADetail = $derived<string>(
    midiLaneCcDetail('A', cardState.ccANum, cardState.learningCcA, cardState.lastCcA),
  );
  let ccBDetail = $derived<string>(
    midiLaneCcDetail('B', cardState.ccBNum, cardState.learningCcB, cardState.lastCcB),
  );
</script>

<div class="midi-lane-device" data-testid="midi-lane-device-body-{nodeId}">
  {#if !cardState.connected}
    {#if cardState.permissionDenied}
      <p class="err" data-testid="midi-lane-access-error-{nodeId}">
        MIDI access was refused, or this browser has no Web MIDI.
      </p>
    {:else}
      <p class="hint">Press Connect MIDI to grant access and pick a device. One-time per origin.</p>
    {/if}
  {:else}
    <label class="row">
      <span class="cap">Device</span>
      <select
        data-testid="midi-lane-device-select-{nodeId}"
        onchange={onChangeDevice}
        value={cardState.selectedDeviceId ?? ''}
      >
        <option value="" disabled>(pick one)</option>
        {#each cardState.devices as d (d.id)}
          <option value={d.id}>{midiLaneDeviceName(d)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="MIDI"
      lit={cardState.connected}
      detail={deviceDetail}
      testid="midi-lane-led-midi-{nodeId}"
    />
    <StatusLed
      caption="NOTE"
      lit={cardState.heldCount > 0}
      detail={noteDetail}
      testid="midi-lane-led-note-{nodeId}"
    />
    <StatusLed
      caption="CC A"
      lit={midiLaneCcLit(cardState.ccANum, cardState.learningCcA)}
      detail={ccADetail}
      testid="midi-lane-led-cc-a-{nodeId}"
    />
    <StatusLed
      caption="CC B"
      lit={midiLaneCcLit(cardState.ccBNum, cardState.learningCcB)}
      detail={ccBDetail}
      testid="midi-lane-led-cc-b-{nodeId}"
    />
  </span>
</div>

<style>
  .midi-lane-device {
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
  /* ⚠ THE CAP IS LOAD-BEARING, NOT COSMETIC. A Windows WinMM roster duplicates
     its device names and can carry very long ones, so an uncapped <select>
     lets somebody else's driver decide how wide this faceplate is. */
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
