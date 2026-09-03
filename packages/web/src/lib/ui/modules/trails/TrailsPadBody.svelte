<script lang="ts">
  // TrailsPadBody — the DOCK surface: the pad mirror, the LINK lamp, MON and its
  // reset, and the monitor readout MON reveals.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here at rest is one of those,
  // instructional copy in an EMPTY state, or an ERROR absent whenever nothing is
  // wrong:
  //
  //   * THE MIRROR — a canvas. It paints no text at all (see the component).
  //   * `bar — not sent over USB-MIDI` — a LANDMARK naming the surface's own
  //     condition and the reason that strip is inert. It measures nothing, it
  //     never changes, and it is gated on the SAME `TRAILS_BAR_TRANSMITS_MIDI`
  //     flag as the hatch, so a firmware that starts transmitting the Bar takes
  //     the hatch and the denial away in ONE edit rather than leaving a stale
  //     denial under a live strip. The samsloop `NO SAMPLE LOADED` / dockscope
  //     `±5V` ground, and the `EXTENSION_BODY_ROLES` `why` spells it out because
  //     that roster is the only gate that can see body text at all.
  //   * THE LINK LAMP, through `StatusLed`: a static literal caption, a lamp
  //     that IS the picture, and the whole status sentence on `aria-label` /
  //     `title`. See `trails-status-model.ts` for why `lit` is NOT `bound`.
  //   * MON / reset — control CAPTIONS on their own buttons.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, replaced by
  //     the lamp's own resolved state the moment a link exists.
  //   * THE FAULT LINE — an ERROR, `role="alert"`, absent whenever nothing is
  //     wrong. For `no-port` it is the only instruction in the product for the
  //     failure a player will actually hit ("Connect the module's USB-C port…"),
  //     and `trails.spec.ts` already asserts that substring and that attribute.
  //
  // ⚠ MON IS THE ONE MEASUREMENT ON THE PLATE, AND IT IS ABSENT AT REST.
  // `monOpen` defaults false, so a resting faceplate paints neither the
  // `loops N · edges a/b/c/d` ratio nor the summary. That is STRONGER than
  // livecode's shipped OUTPUT LOG precedent, which is visible at rest whenever
  // `node.data.lastRun` is set. And its subject is a USB device OUTSIDE the rack
  // — specifically the frames this module's decoder REJECTED — so it is not
  // derived state about any control here and has no control's `aria-valuetext`
  // to move to. It is also the only affordance in the product that can falsify
  // `trails-decode.ts` against real hardware; it has already found three readout
  // defects the hardware was being blamed for.
  //
  // ⚠ NO CONNECT BUTTON HERE, DELIBERATELY. The gesture is a ranked `action`
  // cell in the band below, which is what puts it on the LANE TILE — the whole
  // point of making it a cell. A second button on the same plate would be one
  // gesture with two affordances and a second thing to keep in sync (the
  // midiclock / ptzcam ruling, asserted in `face-trails.spec.ts`).
  //
  // ── ⚠ REACTIVITY: SUBSCRIBE AT INIT, NEVER IN AN $effect ───────────────────
  //
  // `TrailsCardApi` has no push seam. The only live source is the module-level
  // `trailsMidiVersion` store, and `PtzcamCard.svelte:39-51` records the
  // measurement that neither store auto-subscription sugar nor
  // `$effect(() => store.subscribe(...))` delivered its bumps — every
  // seemingly-working bind was riding incidental xyflow data-prop churn, which a
  // shell body does not have at all. Init-time subscribe + `onDestroy` is what
  // works, and it is also what releases the subscription.
  //
  // ⚠ AND NOTHING HERE MUTATES FROM A READ PATH. `trailsStatus()` and
  // `state()` are pure reads; `trails-device.ts` defers its own version bump to
  // a microtask precisely so a bump raised during a `$derived` cannot poison the
  // deriveds with `state_unsafe_mutation`.
  //
  // ⚠ THE MODULE MAKES NO `node.data` WRITES AT ALL and this surface must keep
  // that true (trails.ts:44-51). A live gesture is 100-250 messages a second;
  // routing any of it through the Y.Doc would be 250 CRDT transactions a second
  // broadcast to every collaborator — the cv-modulation live-store-write-storm
  // discipline. `monOpen` is component state for the same reason: a diagnostic
  // panel that reopened itself on every patch load, on every collaborator's
  // screen, is not what "remember my layout" means, and persisting it would be
  // the module's first `node.data` key.

  import { onDestroy, onMount } from 'svelte';
  import { StatusLed } from '$lib/ui/controls';
  import {
    TRAILS_BAR_TRANSMITS_MIDI,
    type TrailsState,
  } from '$lib/audio/modules/trails';
  import type { TrailsMonitorSnapshot } from '$lib/midi/trails-monitor';
  import { trailsMidiVersion, trailsStatus, type TrailsStatus } from '$lib/midi/trails-device';
  import { trailsApi, trailsResetMonitor } from '../trails-cell-actions';
  import TrailsPadMirror from './TrailsPadMirror.svelte';
  import {
    TRAILS_MON_IDLE_TEXT,
    trailsCountersLine,
    trailsLamp,
  } from './trails-status-model';

  let { nodeId }: { nodeId: string } = $props();

  /** The card's own `max-width: 140px`, kept. The dock plate does not have the
   *  260 px card's fit constraint, so this is now a PARITY choice rather than a
   *  forced one — widening it is one CSS value plus a scoped `GREP=trails` VRT
   *  re-pin, and is offered to the owner rather than taken. */
  const DOCK_MIRROR_W = 140;

  /** Frames between MON refreshes — about five a second at 60 fps. Expressed in
   *  FRAMES rather than milliseconds because the cadence is a UI one and the
   *  loop it rides is the frame loop. */
  const MON_REFRESH_FRAMES = 12;

  // Mirror the device layer's version store into rune state — see the header.
  let midiV = $state(0);
  onDestroy(
    trailsMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );
  /** Bumped by this surface's own gestures so api-backed reads re-run at once
   *  rather than waiting for the store's deferred microtask bump. */
  let revision = $state(0);

  let status = $derived.by<TrailsStatus | null>(() => {
    void midiV;
    void revision;
    return trailsApi(nodeId)?.status() ?? trailsStatus();
  });
  let lamp = $derived(trailsLamp(status));

  // ── The MIDI monitor ──────────────────────────────────────────────────────
  //
  // ⚠ THE POINT OF IT IS THE MESSAGES THE MODULE DOES *NOT* UNDERSTAND. Every
  // wire constant this module has is a reading of a manual, and none of them can
  // be falsified from inside the app. The readout marks each row with whether
  // the decoder made an event of it, so one look at real hardware settles what a
  // round trip of guesses would not.
  //
  // ⚠ THE TWO ENGINE READS STAY SEPARATED, and collapsing them is the plausible
  // tidy. `state()` is cheap (integers plus a fixed-size ring) and the MIRROR
  // reads it every frame; `monitor()` SORTS its rows and BUILDS A STRING, and is
  // read only while MON is open, every 12th frame. Polling them together would
  // make the diagnostic the most expensive thing in the module — trails.ts:473
  // says so in as many words — and `state()` returns a FRESH OBJECT per call, so
  // a 60 Hz assignment would re-render the readout for no new information.
  let monOpen = $state(false);
  let monitor = $state<TrailsMonitorSnapshot | null>(null);
  /** The cheap per-frame counters, mirrored for the MON counters line. */
  let counters = $state<TrailsState | null>(null);
  let monFrame = 0;
  let monRaf = 0;

  /** ⚠ THE LOOP EXISTS ONLY WHILE MON IS OPEN, which is where this body differs
   *  from the card — and it differs in the cheap direction. The card owned ONE
   *  rAF that both painted the pad and refreshed MON, so its loop ran always;
   *  here the PAINT loop belongs to `TrailsPadMirror` and this one is pure
   *  diagnostic, so a closed panel costs nothing at all rather than an integer
   *  compare per frame. Still frames rather than an interval: the refresh is a
   *  UI cadence, and a millisecond timer would be an arbitrary delay standing in
   *  for a renderer-dependent one. */
  function monTick(): void {
    if (++monFrame >= MON_REFRESH_FRAMES) {
      monFrame = 0;
      const api = trailsApi(nodeId);
      counters = api?.state() ?? null;
      monitor = api?.monitor() ?? null;
    }
    monRaf = requestAnimationFrame(monTick);
  }

  function startMon(): void {
    if (monRaf) return;
    monFrame = 0;
    monRaf = requestAnimationFrame(monTick);
  }

  function stopMon(): void {
    if (monRaf) cancelAnimationFrame(monRaf);
    monRaf = 0;
  }

  function readNow(): void {
    const api = trailsApi(nodeId);
    counters = api?.state() ?? null;
    monitor = api?.monitor() ?? null;
  }

  function toggleMon(): void {
    monOpen = !monOpen;
    if (monOpen) {
      readNow();
      startMon();
    } else {
      stopMon();
    }
    revision++;
  }

  function resetMon(): void {
    trailsResetMonitor(nodeId);
    readNow();
    revision++;
  }

  onMount(() => stopMon);

  let countersLine = $derived(trailsCountersLine(counters));
</script>

<!-- ⚠ A COLUMN, AND THAT IS A LAYOUT REQUIREMENT RATHER THAN A LOOK.
     `.faceplate-body` is `width: max-content`, so a single flex ROW holding the
     mirror, a wrapping paragraph and the lamps would have a max-content width
     equal to all three UNWRAPPED while the paragraph painted two short lines
     inside it — the 40 px empty-plate ceiling `workflow-shell-faces` enforces
     from the 2026-08-17 ruling. A column's max-content is the MAX of its rows,
     not their sum. -->
<div class="trails-body" data-testid="trails-face-body-{nodeId}">
  <TrailsPadMirror {nodeId} width={DOCK_MIRROR_W} testidPrefix="trails-face" />

  {#if !TRAILS_BAR_TRANSMITS_MIDI}
    <!-- Gated on the same flag the hatch is — see the header. -->
    <p class="bar-note" data-testid="trails-face-bar-note-{nodeId}">
      bar — not sent over USB-MIDI
    </p>
  {/if}

  <div class="row">
    <StatusLed
      caption="LINK"
      lit={lamp.lit}
      tone={lamp.tone}
      detail={lamp.detail}
      testid="trails-face-led-{nodeId}"
    />
    <span class="buttons">
      <button
        type="button"
        class="mon-toggle"
        aria-pressed={monOpen}
        onclick={toggleMon}
        data-testid="trails-face-mon-{nodeId}"
      >
        MON
      </button>
      {#if monOpen}
        <button
          type="button"
          class="mon-toggle"
          onclick={resetMon}
          data-testid="trails-face-mon-reset-{nodeId}"
        >
          reset
        </button>
      {/if}
    </span>
  </div>

  {#if lamp.errorLine}
    <p class="err" role="alert" data-testid="trails-face-status-{nodeId}">{lamp.errorLine}</p>
  {:else if lamp.hint}
    <p class="hint">{lamp.hint}</p>
  {/if}

  {#if monOpen}
    <!-- Answers "is the gate firing every loop?" with nothing patched: LOOPS
         counts the device's restart messages, EDGES counts rising edges per gate
         jack. Read the DELTAS, not the absolute pair — a channel picks up one
         extra edge when its stream starts before the first restart, and a
         note-mode channel is driven by its notes instead. Both reset together,
         so a `reset` gives a clean window to count over. -->
    <p class="mon-counters" data-testid="trails-face-loops-{nodeId}">{countersLine}</p>
    <pre
      class="mon-log"
      data-testid="trails-face-mon-text-{nodeId}">{monitor?.summary ?? TRAILS_MON_IDLE_TEXT}</pre>
  {/if}
</div>

<style>
  .trails-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .bar-note {
    margin: 0;
    font-size: 8px;
    line-height: 1.3;
    opacity: 0.45;
    text-align: center;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    align-self: stretch;
  }
  .buttons {
    display: inline-flex;
    gap: 6px;
    margin-left: auto;
  }
  .mon-toggle {
    font-size: 9px;
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 30ch;
  }
  .hint {
    color: var(--muted, #888);
  }
  .err {
    color: #d66;
  }
  .mon-counters {
    margin: 0;
    align-self: stretch;
    font-size: 9px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  .mon-log {
    margin: 0;
    padding: 6px;
    width: 230px;
    box-sizing: border-box;
    max-height: 132px;
    overflow: auto;
    background: #0c0e12;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    font-size: 8px;
    line-height: 1.35;
    /* Pre-wrapped rather than scrolling sideways: the summary exists to be
       SELECTED AND PASTED into a message, and a horizontally-clipped block
       loses the ends of the rows that matter most. */
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
</style>
