<script lang="ts">
  // MidiOutBuddyDeviceBody — the OUTPUT BINDING surface, at the head of the
  // dock full view.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE OUTPUT picker — the one affordance on this module that cannot be a
  //     face cell. Its roster lives on the engine handle behind
  //     `requestMIDIAccess()` and differs per machine, so it is neither a
  //     `ParamDef` nor an `options` roster (a roster is a fixed set known when
  //     the def is authored). Its painted text is the PORT NAME, which is a
  //     NAME — the cameraInput precedent, made for exactly this problem.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the measurement in `aria-label` / `title`.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state.
  //   * THE ACCESS FAILURE — an ERROR, absent whenever nothing is wrong, and it
  //     stays LOUD for the reason the legacy card records: the suppressed-prompt
  //     case used to produce no message at all.
  //
  // ⚠ NEITHER RANKED CELL IS DUPLICATED HERE. CONNECT and CHANNEL are real
  // cells that reach the lane tile; a body carrying them too would be a second
  // implementation of controls the face already owns.
  //
  // ⚠ WHERE THE CARD'S VIOLET WENT. `MidiOutBuddyCard.svelte` outlined the
  // whole card in `--cable-video` and painted a `CH n != LANE m` badge whenever
  // the module routed off its lane. Both are derived-state text or a
  // derived-state colour standing in for one, so neither may appear at rest.
  // They are the LANE lamp: `tone="warn"` for "this is a fault rather than a
  // readiness", `lit` for the divergence itself, and the badge's own sentence —
  // including how to undo it — as the `detail`. The status model beside this
  // file argues why the violet specifically is not ported.
  //
  // ⚠ THE `channel` SCALARS COME FROM THE DEF'S OWN HELPERS, never re-derived
  // here. `effectiveMidiOutChannel` and `laneChannelOf` are the same functions
  // the engine and the card read, which is what stops the lamp disagreeing with
  // what is actually being sent.
  //
  // ⚠ node.data IS A LIVE Yjs PROXY, NOT A SVELTE SIGNAL, so neither our own
  // writes nor the column reconciler's lane move can wake a `$derived` on their
  // own. `nodeVersion` is the shared version rune for exactly this; the card
  // hand-rolled a `Y.Map.observeDeep` for it before this rune existed.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT.
  //
  // ⚠ UNLIKE cameraInput, THIS NEEDS NO STATUS REGISTRY: `midiOutBuddy` is in
  // neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so
  // promotion parks no live card off-screen and the MIDI sender lives on the
  // engine handle. There is no second owner to coordinate with.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    effectiveMidiOutChannel,
    laneChannelOf,
    type MidiOutBuddyCardState,
    type MidiOutBuddyData,
  } from '$lib/audio/modules/midi-out-buddy';
  import { midiOutBuddyApi } from '../midi-out-buddy-cell-actions';
  import {
    midiOutBuddyErrorLine,
    midiOutBuddyLaneDetail,
    midiOutBuddyLaneDiverged,
    midiOutBuddyPortDetail,
    midiOutBuddyPortName,
    midiOutBuddySendDetail,
  } from './midi-out-buddy-status-model';

  let { nodeId }: { nodeId: string } = $props();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );
  let savedData = $derived<Partial<MidiOutBuddyData>>(
    (node?.data ?? {}) as Partial<MidiOutBuddyData>,
  );

  let cardState = $state<MidiOutBuddyCardState>({
    connected: false,
    permissionDenied: false,
    accessMessage: '',
    devices: [],
    selectedDeviceId: null,
    channel: 1,
    activeNote: null,
  });

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = nodeId;
    void node;
    const api = midiOutBuddyApi(nodeId);
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
    midiOutBuddyApi(nodeId)?.selectDevice(sel);
    // ⚠ ORIGIN-TAGGED — the legacy card's bare proxy write was outside Cmd-Z.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.lastDeviceId = sel;
    });
  }

  // The two channel scalars, from the def's own helpers.
  let sendChannel = $derived<number>(effectiveMidiOutChannel(savedData));
  let laneChannel = $derived<number | null>(laneChannelOf(savedData));
  let laneView = $derived({ laneChannel, channel: sendChannel });

  // Every STRING this surface can produce — including the ones that are never
  // painted — comes from the pure model beside this file.
  let portDetail = $derived<string>(midiOutBuddyPortDetail(cardState));
  let sendDetail = $derived<string>(
    midiOutBuddySendDetail({
      connected: cardState.connected,
      channel: sendChannel,
      activeNote: cardState.activeNote,
    }),
  );
  let laneDetail = $derived<string>(midiOutBuddyLaneDetail(laneView));
  let laneDiverged = $derived<boolean>(midiOutBuddyLaneDiverged(laneView));
  let errorLine = $derived<string | null>(midiOutBuddyErrorLine(cardState));
</script>

<div class="midi-out-buddy-device" data-testid="midi-out-buddy-device-body-{nodeId}">
  {#if !cardState.connected}
    <!-- ⚠ NO CONNECT BUTTON HERE, DELIBERATELY. The gesture is a RANKED ACTION
         CELL in the band below, which is what puts it on the lane tile too. A
         second button on the same plate would be one gesture with two
         affordances. This branch is the EMPTY STATE. -->
    {#if errorLine}
      <p class="err" data-testid="midi-out-buddy-access-error-{nodeId}">{errorLine}</p>
    {:else}
      <p class="hint">Press Connect MIDI to grant access and pick an output. One-time per origin.</p>
    {/if}
  {:else}
    <label class="row">
      <span class="cap">Output</span>
      <select
        data-testid="midi-out-buddy-output-select-{nodeId}"
        onchange={onChangeDevice}
        value={cardState.selectedDeviceId ?? ''}
      >
        <option value="" disabled>(pick one)</option>
        {#each cardState.devices as d (d.id)}
          <option value={d.id}>{midiOutBuddyPortName(d)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <span class="lamps">
    <StatusLed
      caption="MIDI"
      lit={cardState.connected}
      detail={portDetail}
      testid="midi-out-buddy-led-midi-{nodeId}"
    />
    <StatusLed
      caption="SEND"
      lit={cardState.activeNote !== null}
      detail={sendDetail}
      testid="midi-out-buddy-led-send-{nodeId}"
    />
    <StatusLed
      caption="LANE"
      lit={laneDiverged}
      tone="warn"
      detail={laneDetail}
      testid="midi-out-buddy-led-lane-{nodeId}"
    />
  </span>
</div>

<style>
  .midi-out-buddy-device {
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
