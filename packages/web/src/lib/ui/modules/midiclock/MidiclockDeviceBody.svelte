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
  //     IT STAYS LOUD. The reason was written down before the faceplate and is
  //     worth carrying: "The old copy was a one-line hint swap that a user reading a
  //     dead button did not register — and the suppressed-prompt case produced
  //     NO message at all." It comes from the shared `midiOutcomeMessage` seam,
  //     which always yields a nameable outcome including the case where the
  //     browser silently declined to show a prompt.
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE THE FINDING WENT ───────────────
  //
  // The pre-faceplate surface painted two readout rows and BOTH are gone:
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
  //
  // ── THE DEBUG TAIL (owner-requested, 2026-09-03) ───────────────────────────
  //
  // A `debug` toggle beside the lamps opens a running tail of RAW MIDI traffic
  // on the bound input — timestamped hex plus a decoded name per row, ring-
  // bounded (see `$lib/midi/midi-tail`). It exists because "doesn't seem to
  // read start" has two utterly different causes that paint identically:
  // nothing arriving on the port (wrong interface, wrong cable, wrong virtual
  // port) versus arriving-and-dropped (a code defect). The tail is the only
  // surface that can tell them apart in the field.
  //
  //   * ZERO COST CLOSED — the trails MON discipline, engine half included:
  //     the tap (`api.tapMidi`) is installed on OPEN and released on close /
  //     pause / destroy, so a resting body leaves the factory's per-message
  //     path at one short-circuited null check with no always-on listener.
  //   * FRAMES, NOT MILLISECONDS — rows flush to `$state` on a rAF loop every
  //     `TAIL_REFRESH_FRAMES`, the trails cadence; a 48 Hz CLOCK stream must
  //     not become 48 Hz of re-render.
  //   * NO Y.DOC WRITES — the tail, `tailOpen` and `tailPaused` are transient
  //     render state (the cv-modulation write-storm discipline); a diagnostic
  //     panel that reopened itself on every collaborator's screen is not what
  //     "remember my layout" means.
  //   * PAINTED TEXT: the `debug` / `pause` / `clear` control CAPTIONS, the
  //     empty state's honest negative, and the rows — MEASUREMENTS, absent at
  //     rest exactly like trails' MON readout, painted only while a player is
  //     holding the panel open to read them.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { MidiclockCardState } from '$lib/audio/modules/midiclock';
  import { nameOfDevice } from '$lib/graph/device-rebind';
  import { createMidiTailRing, MIDI_TAIL_IDLE_TEXT } from '$lib/midi/midi-tail';
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
    // ⚠ ORIGIN-TAGGED. This key used to be written with a bare SyncedStore
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

  // ── The debug tail (see the header) ─────────────────────────────────────────
  /** Frames between tail flushes — the trails MON cadence, ~5 Hz at 60 fps. */
  const TAIL_REFRESH_FRAMES = 12;

  let tailOpen = $state(false);
  let tailPaused = $state(false);
  let tailText = $state('');
  // Non-reactive plumbing: the ring, the tap release, and the flush loop.
  const tail = createMidiTailRing();
  let untap: (() => void) | null = null;
  let tailDirty = false;
  let tailRaf = 0;
  let tailFrame = 0;

  function flushTail(): void {
    tailText = tail.lines().join('\n');
    tailDirty = false;
  }

  function tailTick(): void {
    if (++tailFrame >= TAIL_REFRESH_FRAMES) {
      tailFrame = 0;
      if (tailDirty) flushTail();
    }
    tailRaf = requestAnimationFrame(tailTick);
  }

  function startTap(): void {
    if (untap) return;
    untap = midiclockApi(nodeId)?.tapMidi((ev) => {
      tail.push(ev);
      tailDirty = true;
    }) ?? null;
  }

  function stopTap(): void {
    untap?.();
    untap = null;
  }

  function toggleTail(): void {
    tailOpen = !tailOpen;
    if (tailOpen) {
      tailPaused = false;
      flushTail();
      startTap();
      tailFrame = 0;
      if (!tailRaf) tailRaf = requestAnimationFrame(tailTick);
    } else {
      stopTap();
      if (tailRaf) cancelAnimationFrame(tailRaf);
      tailRaf = 0;
    }
  }

  /** pause = stop LISTENING (release the tap), keep what is on screen; resume
   *  re-taps. Traffic during a pause is deliberately not recorded — a frozen
   *  tail that silently kept filling would misreport WHEN bytes arrived. */
  function togglePause(): void {
    tailPaused = !tailPaused;
    if (tailPaused) stopTap();
    else startTap();
  }

  function clearTail(): void {
    tail.clear();
    flushTail();
  }

  onDestroy(() => {
    stopTap();
    if (tailRaf) cancelAnimationFrame(tailRaf);
    tailRaf = 0;
  });
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
    <button
      type="button"
      class="tail-toggle"
      aria-pressed={tailOpen}
      title="running tail of raw MIDI traffic on the selected device"
      onclick={toggleTail}
      data-testid="midiclock-debug-{nodeId}"
    >
      debug
    </button>
  </span>

  {#if tailOpen}
    <!-- The MEASUREMENT the plate is otherwise forbidden to paint — absent at
         rest, present only while a player holds the panel open (the trails MON
         licence). Rows are NEWEST FIRST so the message being waited for lands
         at the top, not below a scroll. -->
    <div class="tail">
      <span class="tail-buttons">
        <button
          type="button"
          class="tail-toggle"
          aria-pressed={tailPaused}
          onclick={togglePause}
          data-testid="midiclock-tail-pause-{nodeId}"
        >
          pause
        </button>
        <button
          type="button"
          class="tail-toggle"
          onclick={clearTail}
          data-testid="midiclock-tail-clear-{nodeId}"
        >
          clear
        </button>
      </span>
      <pre
        class="tail-log"
        data-testid="midiclock-tail-{nodeId}">{tailText || MIDI_TAIL_IDLE_TEXT}</pre>
    </div>
  {/if}
</div>

<style>
  /* ⚠ A COLUMN, AND THE DIRECTION IS THE WIDTH GATE'S DOING. This was a
     wrapping ROW (hint/picker + lamps on one line, `margin-left: auto` on the
     lamps), and a row's MAX-CONTENT ask is the SUM of the whole line even
     though the plate would happily wrap it. Adding the `debug` toggle pushed
     that one-line ask past the face band's own, so the plate's width driver
     flipped from the band's BOXY cells (which the width gate credits as
     content) to this body's boxes (which it measures by TEXT RANGES) —
     `face-midiclock-dock` went red with 52 px of "empty plate" that was really
     this row's un-drawn box width. A column's ask is the MAX of its rows, so
     the band stays the plate's driver and the lamps row rides in the stretch
     space — the tidyVco min-width class, fixed at the ask rather than
     exempted. */
  .midiclock-device {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
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
    align-self: flex-end;
  }
  .tail-toggle {
    font-size: 9px;
  }
  .tail {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tail-buttons {
    display: inline-flex;
    gap: 6px;
    align-self: flex-end;
  }
  .tail-log {
    margin: 0;
    padding: 6px;
    box-sizing: border-box;
    /* ⚠ ZERO intrinsic ask, full laid-out width. A `pre` full of unwrapped
       rows would otherwise bid its longest row into the COLUMN's max-content
       and widen the whole plate the moment the panel opens; `width: 0` takes
       it out of the bidding entirely (a percentage cap would not — intrinsic
       sizing ignores percentages) and `min-width: 100%` hands it the body's
       real width at layout. Long rows scroll inside, per the repo rule. */
    width: 0;
    min-width: 100%;
    max-height: 132px;
    overflow: auto;
    background: #0c0e12;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    font-size: 8px;
    line-height: 1.35;
    /* Selectable, wrap-free rows: a tail row is a fixed-width triplet
       (time / hex / name) and wrapping would shear the columns — the block
       scrolls instead, inside its own container. */
    white-space: pre;
    user-select: text;
  }
</style>
