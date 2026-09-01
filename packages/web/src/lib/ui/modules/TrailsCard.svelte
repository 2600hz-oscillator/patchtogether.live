<script lang="ts">
  // TrailsCard — the Bela TRAILS eurorack module's surface.
  //
  // Three things live here, and only one of them is a knob:
  //   * CONNECT — the gesture-gated Web MIDI request. It must be a real click
  //     handler with no `await` above the request, or Chromium spends the user
  //     activation and refuses to prompt.
  //   * the STATUS line — the difference between "no device", "denied",
  //     "the prompt was suppressed" and "bound", all of which look identical
  //     from a silent module.
  //   * the PAD MIRROR — a 1:1 view of the physical panel: the 85 × 85 mm pad
  //     with one coloured dot and one fading trail per channel, plus the
  //     10 × 85 mm Touch Bar drawn HATCHED because the device transmits no
  //     value for it and has no output jack for it either (see
  //     TRAILS_BAR_TRANSMITS_MIDI — the citations are there). A strip that
  //     merely stayed blank would look like a live control that had broken.
  //   * MON — the MIDI monitor. The one affordance that can falsify this
  //     module's wire constants against real hardware, because it reports the
  //     messages the decoder did NOT understand as well as the ones it did.
  //
  // ⚠ THE PAD IS A MIRROR, NOT A CONTROL. It is READ-ONLY: nothing here writes
  // a param, a `node.data` key or a Y.Doc update, and there is no pointer
  // handler on the canvas. That is what makes it honest to call this a bespoke
  // surface rather than an `xyPads` face cell — an `xyPads` pad is declared as
  // the two params its axes DRIVE, and these axes drive nothing; they report.
  //
  // ⚠ THE FRAME LOOP DRAWS ONLY WHEN THE DEVICE MOVED. `axisMessages` is a
  // monotonic counter on the engine handle; the rAF wakes, compares it against
  // the last frame it painted (plus the four gate levels) and returns without
  // touching the 2-D context when nothing changed. A rack full of idle TRAILS
  // cards therefore costs one integer compare per card per frame, not a canvas
  // repaint — and, because an idle card paints EXACTLY the resting grid, the
  // VRT capture of a fresh spawn is deterministic with no mask.

  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic } from '$lib/ui/controls';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    trailsDef,
    TRAILS_BAR_EDGE,
    TRAILS_BAR_GAP_MM,
    TRAILS_BAR_MM,
    TRAILS_BAR_TRANSMITS_MIDI,
    TRAILS_PAD_MM,
    TRAILS_TRAIL_LENGTH,
    type TrailsCardApi,
    type TrailsState,
  } from '$lib/audio/modules/trails';
  import type { TrailsMonitorSnapshot } from '$lib/midi/trails-monitor';
  import { connectTrails, trailsMidiVersion, trailsStatus } from '$lib/midi/trails-device';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);
  const { paramVal, set, live, engineCtx } = cardParams(
    trailsDef,
    () => id,
    () => node,
  );

  const KNOBS = ['range', 'smooth', 'divisor'] as const;

  /** One colour per channel, matching the hardware's shine-through LEDs closely
   *  enough to tell four fingers apart at 150 px. */
  const CHANNEL_COLOURS = ['#4ecdc4', '#f2c14e', '#e06c9f', '#7aa2f7'] as const;

  /** Bumped by user actions so api-backed reads re-run alongside the store. */
  let revision = $state(0);

  // Mirror the device layer's version store into rune state with an INIT-TIME
  // subscription (the PtzcamCard finding: neither store sugar nor an
  // `$effect(() => store.subscribe(...))` bridge delivers updates here).
  let midiV = $state(0);
  onDestroy(
    trailsMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );

  function api(): TrailsCardApi | null {
    const engine = engineCtx.get();
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as TrailsCardApi | undefined) ?? null;
  }

  let status = $derived.by(() => {
    void midiV;
    void revision;
    return api()?.status() ?? trailsStatus();
  });
  let problem = $derived(status.kind !== 'bound' && status.kind !== 'idle');

  function onConnect(): void {
    // Straight from the click handler — an `await` above the request spends the
    // user activation. When this node's engine handle is not built yet (a click
    // can race the reconciler) fall through to the app-level connect rather
    // than dropping the gesture.
    const a = api();
    void (a ? a.connect() : connectTrails());
    revision++;
  }

  // ── The pad mirror ────────────────────────────────────────────────────────

  // ── The MIDI monitor ──────────────────────────────────────────────────────
  //
  // ⚠ THE POINT OF IT IS THE MESSAGES THE MODULE DOES *NOT* UNDERSTAND. Every
  // wire constant this module has — the CC pair, the channel map, which statuses
  // matter — is a reading of a manual, and none of them can be falsified from
  // inside the app. The readout marks each row with whether the decoder made an
  // event of it, so one look at real hardware settles what a round trip of
  // guesses would not.

  let monOpen = $state(false);
  let monitor = $state<TrailsMonitorSnapshot | null>(null);
  /** The cheap per-frame counters, mirrored for the MON header line. */
  let counters = $state<TrailsState | null>(null);
  let monFrame = 0;
  /** Frames between MON refreshes — about five a second at 60 fps. Expressed
   *  in FRAMES rather than milliseconds because the loop it rides is the frame
   *  loop. */
  const MON_REFRESH_FRAMES = 12;

  function toggleMon(): void {
    monOpen = !monOpen;
    if (monOpen) {
      monitor = api()?.monitor() ?? null;
      counters = readState();
      monFrame = 0;
    }
  }

  function resetMon(): void {
    api()?.resetMonitor();
    monitor = api()?.monitor() ?? null;
    counters = readState();
  }

  let canvas = $state<HTMLCanvasElement | null>(null);
  let rafId = 0;
  /** The `axisMessages` count + packed gate levels of the last painted frame.
   *  −1 forces the first paint (the resting grid). */
  let lastPainted = -1;
  let lastGateMask = -1;
  /** CSS size of the last painted frame, so a resize repaints an idle card. */
  let lastSize = '';

  function readState(): TrailsState | null {
    return api()?.state() ?? null;
  }

  // ── The panel's geometry, in the hardware's own millimetres ───────────────
  //
  // The mirror is 1:1, so it is laid out from the module's exported dimensions
  // and not from pixels picked to look right. `vertical` is true when the Bar
  // runs up a side, which swaps which axis the extra millimetres are added to.
  const BAR_VERTICAL = TRAILS_BAR_EDGE === 'left' || TRAILS_BAR_EDGE === 'right';
  const BAR_FIRST = TRAILS_BAR_EDGE === 'top' || TRAILS_BAR_EDGE === 'left';
  const SPAN_MM = TRAILS_PAD_MM + TRAILS_BAR_GAP_MM + TRAILS_BAR_MM;
  /** width / height of the whole mirror, as the panel has it. */
  const MIRROR_ASPECT = BAR_VERTICAL ? SPAN_MM / TRAILS_PAD_MM : TRAILS_PAD_MM / SPAN_MM;

  function paint(state: TrailsState | null): void {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const cssW = el.clientWidth || 150;
    const cssH = el.clientHeight || Math.round(cssW / MIRROR_ASPECT);
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (el.width !== pxW || el.height !== pxH) {
      el.width = pxW;
      el.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Where the pad ends and the Bar begins, in CSS px along the axis they
    // share. Derived from the millimetres so the two strips keep the panel's
    // real proportions at any card width.
    const spanPx = BAR_VERTICAL ? cssW : cssH;
    const padPx = (spanPx * TRAILS_PAD_MM) / SPAN_MM;
    const barPx = (spanPx * TRAILS_BAR_MM) / SPAN_MM;
    const padOffset = BAR_FIRST ? spanPx - padPx : 0;
    const barOffset = BAR_FIRST ? 0 : spanPx - barPx;

    const padX = BAR_VERTICAL ? padOffset : 0;
    const padY = BAR_VERTICAL ? 0 : padOffset;
    const padW = BAR_VERTICAL ? padPx : cssW;
    const padH = BAR_VERTICAL ? cssH : padPx;

    // Resting surface: the pad's face plus a centre cross. Drawn every frame so
    // there is no "cleared to nothing" state a stalled producer could leave.
    ctx.fillStyle = '#101318';
    ctx.fillRect(padX, padY, padW, padH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX + padW / 2, padY);
    ctx.lineTo(padX + padW / 2, padY + padH);
    ctx.moveTo(padX, padY + padH / 2);
    ctx.lineTo(padX + padW, padY + padH / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.strokeRect(padX + 0.5, padY + 0.5, padW - 1, padH - 1);

    // ── THE TOUCH BAR ───────────────────────────────────────────────────────
    //
    // Drawn because the mirror is a picture of the panel and the panel has one.
    // Drawn HATCHED AND DIM because the device does not transmit it: the
    // hardware has no Bar output jack and its MIDI table is eight rows of X/Y,
    // so there is no value to show and there is no patch that would produce
    // one. An empty-but-normal-looking strip would read as a live control that
    // is broken; the hatch says "not a signal" at a glance, and the caption
    // under the canvas says it in words.
    paintBar(ctx, {
      x: BAR_VERTICAL ? barOffset : 0,
      y: BAR_VERTICAL ? 0 : barOffset,
      w: BAR_VERTICAL ? barPx : cssW,
      h: BAR_VERTICAL ? cssH : barPx,
    });

    if (!state) return;

    // The pad's Y axis points UP; the canvas's points DOWN. Flipping here is
    // what makes the view a MIRROR of the surface rather than of its reflection.
    const sx = (u: number): number => padX + u * padW;
    const sy = (u: number): number => padY + (1 - u) * padH;

    // ⚠ CLIPPED TO THE PAD. A touch point is drawn with a fixed 4 px radius, but
    // the pad→bar gap is a PROPORTION (3 of 98), so below about a 114 px canvas
    // the gap is narrower than the dot and a touch at the pad's bottom edge
    // would paint over the Touch Bar — putting live-looking ink on the one
    // surface whose whole message is that it carries no data.
    ctx.save();
    ctx.beginPath();
    ctx.rect(padX, padY, padW, padH);
    ctx.clip();

    for (let i = 0; i < state.channels.length; i++) {
      const ch = state.channels[i];
      if (!ch || !ch.gate) continue;
      const colour = CHANNEL_COLOURS[i % CHANNEL_COLOURS.length]!;
      // Trail: oldest point faintest. One stroke per segment so the fade is
      // real rather than a single translucent polyline.
      for (let p = 1; p < ch.trail.length; p++) {
        const a = ch.trail[p - 1]!;
        const b = ch.trail[p]!;
        ctx.globalAlpha = (p / TRAILS_TRAIL_LENGTH) * 0.7;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(sx(ch.x), sy(ch.y), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** The Bar strip: a dim face with a diagonal hatch, in the same border
   *  language as the pad so the two read as one panel. */
  function paintBar(
    ctx: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
  ): void {
    ctx.save();
    ctx.fillStyle = TRAILS_BAR_TRANSMITS_MIDI ? '#101318' : '#0c0e12';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (!TRAILS_BAR_TRANSMITS_MIDI) {
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      const step = 6;
      ctx.beginPath();
      for (let d = -r.h; d < r.w + r.h; d += step) {
        ctx.moveTo(r.x + d, r.y + r.h);
        ctx.lineTo(r.x + d + r.h, r.y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }

  function frame(): void {
    const state = readState();
    let gateMask = 0;
    if (state) {
      for (let i = 0; i < state.channels.length; i++) {
        if (state.channels[i]?.gate) gateMask |= 1 << i;
      }
    }
    const stamp = state ? state.axisMessages : 0;
    // ⚠ SIZE IS PART OF THE DIRTY CHECK. The backing-store resize lives inside
    // `paint()`, so a card or window resize (or a DPR change from a monitor
    // switch) with no device attached would otherwise leave a stale, stretched
    // canvas indefinitely — the idle case is exactly the one with no stream to
    // trigger a repaint.
    const size = canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : '';
    if (stamp !== lastPainted || gateMask !== lastGateMask || size !== lastSize) {
      lastPainted = stamp;
      lastGateMask = gateMask;
      lastSize = size;
      paint(state);
    }
    // The MON readout rides THIS loop rather than a timer of its own: the
    // refresh is a UI cadence, and a card that already wakes every frame should
    // not also own an interval. Every Nth frame rather than every frame for two
    // reasons — rendering the monitor's summary sorts its rows and builds a
    // string, and `state()` returns a FRESH OBJECT each call, so assigning it
    // sixty times a second would re-render the readout that often for no new
    // information.
    if (monOpen && ++monFrame >= MON_REFRESH_FRAMES) {
      monFrame = 0;
      counters = state;
      monitor = api()?.monitor() ?? null;
    }
    rafId = requestAnimationFrame(frame);
  }

  onMount(() => {
    paint(readState());
    rafId = requestAnimationFrame(frame);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  });

  const inputs = portsFromDef(trailsDef.inputs);
  const outputs = portsFromDef(trailsDef.outputs);
</script>

<div class="mod-card trails-card" data-testid={`trails-card-${id}`}>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="TRAILS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="bind-row">
      <span class={`led led-${status.kind}`} data-testid={`trails-led-${id}`}></span>
      {#if status.kind !== 'bound'}
        <button type="button" class="connect" onclick={onConnect} data-testid={`trails-connect-${id}`}>
          Connect
        </button>
      {/if}
    </div>

    <p
      class="status"
      class:problem
      role={problem ? 'alert' : undefined}
      data-testid={`trails-status-${id}`}
    >
      {status.message}
    </p>

    <div class="pad-wrap">
      <canvas
        bind:this={canvas}
        class="pad"
        style={`aspect-ratio: ${MIRROR_ASPECT};`}
        data-testid={`trails-pad-${id}`}
      ></canvas>
    </div>
    {#if !TRAILS_BAR_TRANSMITS_MIDI}
      <!-- The caption is gated on the same flag the hatch is, so a firmware that
           starts transmitting the Bar takes both the hatch and this line away in
           one edit rather than leaving a stale denial under a live strip. -->
      <p class="bar-note" data-testid={`trails-bar-note-${id}`}>
        bar — not sent over USB-MIDI
      </p>
    {/if}

    <div class="mon-row">
      <button
        type="button"
        class="mon-toggle"
        aria-pressed={monOpen}
        onclick={toggleMon}
        data-testid={`trails-mon-${id}`}
      >
        MON
      </button>
      {#if monOpen}
        <button type="button" class="mon-toggle" onclick={resetMon} data-testid={`trails-mon-reset-${id}`}>
          reset
        </button>
      {/if}
    </div>

    {#if monOpen}
      <!-- Answers "is the gate firing every loop?" with nothing patched: LOOPS
           counts the device's restart messages, EDGES counts rising edges per
           gate jack. Read the DELTAS, not the absolute pair — a channel picks
           up one extra edge when its stream starts before the first restart,
           and a note-mode channel is driven by its notes instead. Both reset
           together, so a `reset` gives a clean window to count over. -->
      <p class="mon-counters" data-testid={`trails-loops-${id}`}>
        loops {counters?.loopRestarts ?? 0} · edges {(counters?.gateEdges ?? [0, 0, 0, 0]).join('/')}
      </p>
      <pre class="mon-log" data-testid={`trails-mon-text-${id}`}>{monitor?.summary
          ?? 'MIDI monitor idle — press CONNECT, then touch the pad.'}</pre>
    {/if}

    <div class="knob-row">
      {#each KNOBS as knobId (knobId)}
        {@const spec = paramSpec(trailsDef, knobId)}
        <!-- min/max/curve/defaultValue come from the DEF via paramSpec — never
             re-typed here (card-range-source / card-control-ranges gates). -->
        <KnobConic
          value={paramVal(knobId)}
          min={spec.min}
          max={spec.max}
          defaultValue={spec.defaultValue}
          curve={spec.curve}
          label={knobId}
          moduleId={id}
          paramId={knobId}
          onchange={set(knobId)}
          readLive={live(knobId)}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .trails-card {
    width: 260px;
  }
  .stripe {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 0;
  }
  .connect {
    font-size: 10px;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex: none;
  }
  .led-bound {
    background: #4caf7d;
  }
  .led-no-port,
  .led-denied,
  .led-no-prompt,
  .led-unsupported {
    background: #d98a3a;
  }
  .status {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    line-height: 1.3;
    opacity: 0.75;
  }
  .status.problem {
    color: #d98a3a;
    opacity: 1;
  }
  .pad-wrap {
    padding: 8px 14px 0;
    display: flex;
    justify-content: center;
  }
  .pad {
    display: block;
    /* The aspect ratio is set INLINE from the module's millimetre constants —
       the mirror is 1:1 with a panel that is a square pad plus a strip, so the
       proportion is a hardware fact rather than a style choice, and moving the
       Bar to another edge must move the picture with it. Capped rather than
       filling the card: a full-width pad would put the card's natural height
       well past its declared rack tier for no extra readable detail — four
       dots and their trails resolve fine at this size. */
    width: 100%;
    max-width: 140px;
    border-radius: 3px;
  }
  .bar-note {
    margin: 0;
    padding: 3px 14px 0;
    font-size: 8px;
    line-height: 1.3;
    opacity: 0.45;
    text-align: center;
  }
  .mon-row {
    display: flex;
    gap: 6px;
    padding: 6px 14px 0;
  }
  .mon-toggle {
    font-size: 9px;
  }
  .mon-counters {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  .mon-log {
    margin: 4px 14px 0;
    padding: 6px;
    max-height: 132px;
    overflow: auto;
    background: #0c0e12;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    font-size: 8px;
    line-height: 1.35;
    /* Pre-wrapped rather than scrolling sideways: the summary is meant to be
       SELECTED AND PASTED into a message, and a horizontally-clipped block
       loses the ends of the rows that matter most. */
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .knob-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 8px 14px 10px;
  }
</style>
