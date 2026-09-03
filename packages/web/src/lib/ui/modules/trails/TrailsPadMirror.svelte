<script lang="ts">
  // TrailsPadMirror — the 1:1 picture of the Bela Trails panel, as ONE
  // component mounted by BOTH body slots.
  //
  // ⚠ ONE COMPONENT, NOT TWO THAT AGREE. `face-rack-status-source`'s `picture`
  // predicate (`paintsCanvas`) follows exactly one level of local `./X.svelte`
  // imports that are actually MOUNTED, so `TrailsPadBody` mounting this file is
  // what satisfies the declared role — and the roster is structurally blind to a
  // `tileBody`, so what the gate proves of the dock body is true of the tile BY
  // CONSTRUCTION rather than by two files happening to draw the same thing. The
  // audioIn argument, and the reason the `size` difference is a PROP.
  //
  // ⚠ THE PAD IS A MIRROR, NOT A CONTROL. There is no pointer handler here and
  // there must never be one: it writes no param, no `node.data` key and no Y.Doc
  // update, which is what makes it honest as a body rather than an `xyPads`
  // cell — a declared pad names the two params its axes DRIVE, and these axes
  // drive nothing, they report (trails.ts:596-603). The read-only property
  // matters MORE on the tile than on the dock: a lane tile and an open dock pane
  // for one node are mounted at the same time, and two steering surfaces over
  // one cursor is the trap skifree's extension header names by measurement.
  //
  // ⚠ THE FRAME LOOP DRAWS ONLY WHEN THE DEVICE MOVED, carried over from the
  // card verbatim. `axisMessages` is a monotonic counter on the engine handle;
  // the rAF wakes, compares it against the last frame it painted (plus the four
  // gate levels AND the CSS size) and returns without touching the 2-D context
  // when nothing changed. A rack full of idle TRAILS therefore costs one integer
  // compare per mounted mirror per frame, not a canvas repaint — and, because an
  // idle mirror paints EXACTLY the resting grid, the VRT capture of a fresh
  // spawn is deterministic with no mask and no `simPin`.
  //
  // ⚠ SIZE IS PART OF THE DIRTY CHECK, and dropping it is the plausible tidy.
  // The backing-store resize lives inside `paint()`, so a resize (or a DPR
  // change from a monitor switch) with no device attached would otherwise leave
  // a stale, stretched canvas indefinitely — the idle case is exactly the one
  // with no stream to trigger a repaint.
  //
  // ⚠ IT IS 2-D AND MUST STAY 2-D. WebGL attest-basis membership is derived from
  // CONTENT over `lib/ui/modules/**/*.svelte` (`scripts/webgl-attest-lib.ts`),
  // so a GL context here would enrol an AUDIO module in the GPU attest for a
  // picture that is a rectangle, a centre cross, a hatch and four dots.
  // `getContext('2d')`, always.
  //
  // ⚠ NOTHING IS PAINTED INTO THE CANVAS AS TEXT — no coordinates, no channel
  // numbers, no counts. This roster's own blind spot is "what a canvas paints",
  // and the honest way to stay out of it is to paint no text at all.

  import { onMount } from 'svelte';
  import {
    TRAILS_BAR_EDGE,
    TRAILS_BAR_GAP_MM,
    TRAILS_BAR_MM,
    TRAILS_BAR_TRANSMITS_MIDI,
    TRAILS_PAD_MM,
    TRAILS_TRAIL_LENGTH,
    type TrailsState,
  } from '$lib/audio/modules/trails';
  import { trailsApi } from '../trails-cell-actions';

  interface Props {
    nodeId: string;
    /** CSS width of the mirror in px. The HEIGHT is derived from the hardware's
     *  own millimetres through `MIRROR_ASPECT` and is never passed in — the
     *  proportion is a fact about the panel, not a layout choice. */
    width: number;
    /** `trails-face` on the dock body, `trails-tile` on the lane tile. Both are
     *  mounted at once for one node, so a SHARED stem would put two elements
     *  behind one testid — the bug skifree's extension header names. */
    testidPrefix: string;
  }
  let { nodeId, width, testidPrefix }: Props = $props();

  /** One colour per channel, matching the hardware's shine-through LEDs closely
   *  enough to tell four fingers apart at 140 px. */
  const CHANNEL_COLOURS = ['#4ecdc4', '#f2c14e', '#e06c9f', '#7aa2f7'] as const;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let rafId = 0;
  /** The `axisMessages` count + packed gate levels of the last painted frame.
   *  −1 forces the first paint (the resting grid). */
  let lastPainted = -1;
  let lastGateMask = -1;
  /** CSS size of the last painted frame, so a resize repaints an idle mirror. */
  let lastSize = '';

  function readState(): TrailsState | null {
    return trailsApi(nodeId)?.state() ?? null;
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
    const cssW = el.clientWidth || width;
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
    // real proportions at any mirror width.
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
    // is broken; the hatch says "not a signal" at a glance on BOTH tiers, and
    // on the dock the caption under the canvas says it in words.
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
    // surface whose whole message is that it carries no data. That is MORE
    // likely on the 40 px lane mirror than it ever was on the card, not less,
    // which is why the clip travels with the component rather than being a
    // dock-only nicety.
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
    const size = canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : '';
    if (stamp !== lastPainted || gateMask !== lastGateMask || size !== lastSize) {
      lastPainted = stamp;
      lastGateMask = gateMask;
      lastSize = size;
      paint(state);
    }
    rafId = requestAnimationFrame(frame);
  }

  onMount(() => {
    // ⚠ THE FIRST PAINT IS SYNCHRONOUS, and it is the cheap kind: a fill, a
    // cross, a hatch and two strokes on a canvas at most 140 px wide. There is
    // no probe, no decode and no device access on this path — the module's MIDI
    // subscription, its decoder and all twenty-one `ConstantSource`s live in the
    // FACTORY and run with no surface mounted, so mounting a mirror asks the
    // hardware for nothing.
    paint(readState());
    rafId = requestAnimationFrame(frame);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  });
</script>

<canvas
  bind:this={canvas}
  class="trails-mirror"
  style={`width: ${width}px; aspect-ratio: ${MIRROR_ASPECT};`}
  data-testid={`${testidPrefix}-pad-${nodeId}`}
></canvas>

<style>
  .trails-mirror {
    /* The aspect ratio is set INLINE from the module's millimetre constants —
       the mirror is 1:1 with a panel that is a square pad plus a strip, so the
       proportion is a hardware fact rather than a style choice, and moving the
       Bar to another edge must move the picture with it. */
    display: block;
    border-radius: 3px;
    flex: none;
  }
</style>
