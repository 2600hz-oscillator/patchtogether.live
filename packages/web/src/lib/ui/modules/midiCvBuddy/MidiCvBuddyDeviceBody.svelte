<script lang="ts">
  // MidiCvBuddyDeviceBody — the DEVICE BINDING surface, at the head of the dock
  // full view.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE DEVICE picker — the one affordance on this module that cannot be a
  //     face cell. Its roster lives on the engine handle behind
  //     `requestMIDIAccess()` and differs per machine, so it is neither a
  //     `ParamDef` nor an `options` roster (a roster is a fixed set known when
  //     the def is authored). Its painted text is the DEVICE NAME, which is a
  //     NAME — the cameraInput precedent, made for exactly this problem.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the measurement in `aria-label` / `title`.
  //     Nothing about their state reaches a text node.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, and the
  //     empty state is the whole content of the plate before a grant.
  //   * THE ACCESS FAILURE — an ERROR, absent whenever nothing is wrong.
  //
  // ⚠ NONE OF THE FOUR RANKED CELLS IS DUPLICATED HERE. CONNECT, CHANNEL,
  // PRIORITY and RETRIGGER are all real cells that reach the lane tile; a body
  // carrying them too would be a second implementation of controls the face
  // already owns.
  //
  // ⚠ WHAT THE PROMOTION DELETED, AND WHERE THE FINDING WENT. The legacy card
  // painted `NOTE  C4` and `VEL  100`. Both are derived-state text and both are
  // gone from the plate — they are the NOTE LAMP, whose `detail` says the note,
  // the velocity and how many keys are down. See the status model for why the
  // lamp binds to `heldCount` rather than the latched `lastNote`, and for the
  // finding that would otherwise have lost its surface.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT. The `$effect` teardown
  // plus `onDestroy` is the card's pattern, and a body that subscribed without
  // unsubscribing is the node-resource-leak class from the other side.
  //
  // ⚠ UNLIKE cameraInput, THIS NEEDS NO STATUS REGISTRY: `midiCvBuddy` is in
  // neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so
  // promotion parks no live card off-screen and the MIDI handler is installed
  // engine-side through an identity-scoped claim in the factory. There is no
  // second owner to coordinate with.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { MidiCvBuddyCardState } from '$lib/audio/modules/midi-cv-buddy';
  import { midiCvBuddyApi } from '../midi-cv-buddy-cell-actions';
  import {
    midiCvBuddyDeviceDetail,
    midiCvBuddyDeviceName,
    midiCvBuddyErrorLine,
    midiCvBuddyNoteDetail,
  } from './midi-cv-buddy-status-model';

  let { nodeId }: { nodeId: string } = $props();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  let cardState = $state<MidiCvBuddyCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    lastNote: null,
    lastVelocity: 0,
    heldCount: 0,
  });

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = nodeId;
    void node;
    const api = midiCvBuddyApi(nodeId);
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
    midiCvBuddyApi(nodeId)?.selectDevice(sel);
    // ⚠ ORIGIN-TAGGED. The legacy card wrote this key with a bare SyncedStore
    // proxy write — no `transact`, no `LOCAL_ORIGIN` — so picking a device
    // synced to collaborators but never reached the UndoManager, i.e. it was
    // silently outside Cmd-Z. `mutateNode` is the sanctioned seam.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.lastDeviceId = sel;
    });
  }

  // Every STRING this surface can produce — including the ones that are never
  // painted — comes from the pure model beside this file. An unpainted string
  // that is wrong is invisible to a VRT baseline and to a human reading one, so
  // they are decided where a unit test can read them.
  let deviceDetail = $derived<string>(midiCvBuddyDeviceDetail(cardState));
  let noteDetail = $derived<string>(midiCvBuddyNoteDetail(cardState));
  let errorLine = $derived<string | null>(midiCvBuddyErrorLine(cardState));
</script>

<div class="midi-cv-buddy-device" data-testid="midi-cv-buddy-device-body-{nodeId}">
  {#if !cardState.connected}
    <!-- ⚠ NO CONNECT BUTTON HERE, DELIBERATELY. The gesture is a RANKED ACTION
         CELL in the band below, which is what puts it on the lane tile too —
         the whole point of making it a cell rather than a body control. A
         second button on the same plate would be one gesture with two
         affordances, which is clutter under "compact is the default" and, worse,
         a second thing to keep in sync. This branch is the EMPTY STATE: what to
         do, and why nothing is listed yet. -->
    {#if errorLine}
      <p class="err" data-testid="midi-cv-buddy-access-error-{nodeId}">{errorLine}</p>
    {:else}
      <p class="hint">Press Connect MIDI to grant access and pick a device. One-time per origin.</p>
    {/if}
  {:else}
    <label class="row">
      <span class="cap">Device</span>
      <select
        data-testid="midi-cv-buddy-device-select-{nodeId}"
        onchange={onChangeDevice}
        value={cardState.selectedDeviceId ?? ''}
      >
        <option value="" disabled>(pick one)</option>
        {#each cardState.devices as d (d.id)}
          <option value={d.id}>{midiCvBuddyDeviceName(d)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="MIDI"
      lit={cardState.connected}
      detail={deviceDetail}
      testid="midi-cv-buddy-led-midi-{nodeId}"
    />
    <StatusLed
      caption="NOTE"
      lit={cardState.heldCount > 0}
      detail={noteDetail}
      testid="midi-cv-buddy-led-note-{nodeId}"
    />
  </span>
</div>

<style>
  .midi-cv-buddy-device {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  /* ⚠ THE CAP IS A WIDTH DECISION, NOT A TYPOGRAPHIC ONE, AND IT IS MEASURED.
     `.faceplate-body` is `width: max-content`, so the plate is sized by the
     widest child's MAX-CONTENT — and a paragraph's max-content is its
     UNWRAPPED width unless it is capped. At the 34ch this body was copied with,
     the pre-connect hint measured 213 CSS px and made the device strip 332,
     against a widest control row of 294: the plate came out 38 px wider than
     anything drawn in it, and `workflow-shell-faces`' width gate reddened at
     44 px of empty plate against its 40 px ceiling (the shell's own chrome —
     the editor's 22 px padding, the body's 10 and a 1 px border — accounts for
     33 of that on every face, which is the gate's documented normal mode).
     A narrow column of instructional copy keeps the CONTROLS as the thing that
     sizes the plate, which is what "compact is the default" means here. `ch`
     rather than px so it tracks the font. */
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 20ch;
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
