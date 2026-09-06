// packages/web/src/lib/ui/media/frame-producers.ts
//
// THE NODE-LIFETIME PER-FRAME PRODUCERS (legacy-removal S1). See
// ./node-frame-producer-registry for the mechanism, the shared ticker, and why
// this is a registry rather than a permanent off-screen card mount.
//
// Each producer here is the rAF body that used to live on a `*Card.svelte`,
// with the CARD-SPECIFIC half left behind. That split is the whole edit, and it
// is worth naming precisely because the two halves look alike:
//
//   PRODUCE — reading the engine's own live state (a CV tap, an analyser
//   window, an upstream module's frame) and writing a derivation of it back
//   into the module handle. Engine-visible; every consumer of the module sees
//   it; it must run while the NODE exists.
//
//   PAINT — putting a picture on a surface someone is looking at. View-scoped;
//   it must run while the SURFACE exists and stop when it does not.
//
// The cards ran both in one loop, so `PRODUCE` inherited `PAINT`'s lifetime and
// a module went dark, silent or stale whenever no card was mounted (#1587).
// Here the two are separate by construction: nothing in this file can paint —
// it has no element to paint on.
//
// ⚠ EVERY import here is READ-ONLY on `$lib/audio/**` / `$lib/video/**`, the
// same discipline `extras-producers.ts` records: `lib/video/**` is hashed
// WHOLESALE for the WebGL attest, so importing is free and editing is not.

import { rasterizeDef } from '$lib/audio/modules/rasterize';
import { scopeDef } from '$lib/audio/modules/scope';
import { applyBeatBoost, beatPulse } from '$lib/audio/modules/timelorde-wizard';
import { videoChannelLevels } from '../../../../../dsp/src/lib/synesthesia-dsp';
import {
  frameProducerTypes,
  type FrameCtx,
  type FrameImage,
  type FrameProducer,
  type FrameSurface,
} from './node-frame-producer-registry';

/**
 * SCOPE — the combined (knob + CV) draw parameters.
 *
 * ⚠ THIS IS HOW A SAME-DOMAIN CV CABLE REACHES A DISPLAY PARAM AT ALL, which is
 * why it is a producer and not a repaint detail. `AudioEngine.addEdge` connects
 * a cv cable to the AudioParam and never calls `setParam`, and the per-frame CV
 * bridge exists only on the video side (#1664). So the module's nine display
 * params have no path from a patched cable to `drawFrame` except this push:
 * `readParam` returns the knob PLUS the engine's own per-port tap, and
 * `write(node,'cvCombined')` folds it into the module's own CV shadows — the
 * single source of truth BOTH render paths read (`read('drawParams')` for a
 * surface, `drawFrame` for `out`).
 *
 * ⚠ AND THE FAILURE WITHOUT IT IS A LATCH, NOT A FALLBACK. `$lib/audio/cv-shadow`
 * `read()` returns `combined ?? knobValue`, and `combined` is cleared ONLY by a
 * knob move. Stop the push and every param that was under CV stays frozen at
 * whatever value the modulator happened to be at — indefinitely, on a picture
 * that keeps moving, so nothing about it looks broken. `dom-source-modules.ts`
 * records the correction that first got this wrong in the other direction
 * ("degrades to the knob" — a self-limiting failure it does not have).
 *
 * ⚠ TWO SURFACES USED TO RUN THIS PUSH, AND THAT IS WHY IT MOVED RATHER THAN
 * BEING DELETED FROM ONE OF THEM. `ScopeCard.svelte` ran it inside its
 * `onMeterFrame` body and `scope/ScopeScreenBody.svelte` ran a second copy
 * inside its own, each with the same loop over `scopeDef.params` and the same
 * comment explaining why. Two writers of one engine channel is not a bug while
 * they agree, and they agreed exactly because one was pasted from the other —
 * which is the condition under which they stop agreeing silently. There is one
 * writer now, and it is not a surface.
 */
export const SCOPE_FRAME_PRODUCER: FrameProducer = {
  type: 'scope',
  why:
    'the module owns no AnalyserNode per port, so its nine display params reach `drawFrame` ' +
    'only through `write(node,"cvCombined")` — the inverse of `read("drawParams")`. With no ' +
    'writer, a param under CV LATCHES at its last modulated value forever (cv-shadow clears ' +
    '`combined` only on a knob move), so the trace and `out` keep moving on stale numbers.',
  frame({ node, engine }) {
    // ⚠ ALL NINE, EVERY FRAME, AND UNCONDITIONALLY. Sampling only the patched
    // ports would need an edge scan per frame to decide which those are, and it
    // would be WRONG the frame a cable is pulled: the shadow keeps the last
    // combined value until someone overwrites it, so a param whose cable has
    // just gone away has to be re-written with the bare knob to come back.
    // `readParam` costs a map lookup per param when nothing is patched.
    const combined: Record<string, number> = {};
    for (const p of scopeDef.params) {
      const v = engine.readParam(node, p.id);
      if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
    }
    engine.write(node, 'cvCombined', combined);
  },
};

// ── SYNESTHESIA: the cross-domain PIXEL path ─────────────────────────────────
//
// ⚠ THIS IS AN AUDIO MODULE READING PIXELS, which is why the work cannot be
// done where the rest of the module lives. In VIDEO mode each copy's four lanes
// are the R/G/B/Luma channels of whatever is patched into `{c}_video_in`, and
// only the DOM has a canvas — the worklet cannot sample a frame. So something
// on the main thread must resolve the upstream source, get one frame of it into
// a raster it can read back, average it, and hand the four numbers to the
// worklet, which sample-and-holds them through the whole env/gate/meter stage.
//
// Those numbers are what the module's FORTY-EIGHT output jacks carry in VIDEO
// mode: the band envelopes, the gates, the beat triggers and the per-band
// rasters. Stop the push and they do not go quiet — they FREEZE at the last
// sampled frame, or never leave zero, with every cable still visibly patched.

/** The scratch raster the frame is averaged over. 64×48 is the card's own size,
 *  kept identical so the computed levels are byte-for-byte what they were. */
const SYN_FRAME_W = 64;
const SYN_FRAME_H = 48;

/** The two copies. Each switches mode independently; the card's own `isVideo`
 *  read, moved verbatim. */
const SYN_COPIES = ['a', 'b'] as const;

function synIsVideo(ctx: FrameCtx, copy: 'a' | 'b'): boolean {
  const raw = ctx.node.params?.[`${copy}_mode`];
  return Math.round(typeof raw === 'number' ? raw : 0) === 1;
}

/**
 * Draw whatever is patched into `{copy}_video_in` into the node's scratch
 * raster, then read its pixels → [R,G,B,Luma] levels (0..1).
 *
 * Returns null when nothing is patched or the frame cannot be read — and NULL
 * IS NOT AN ERROR: it is "no source", which must leave the worklet's held value
 * alone rather than pushing zeros, exactly as the card did. The gate then stays
 * closed and the meters stay dark, which is the correct picture of "nothing
 * connected".
 */
function synVideoLevels(ctx: FrameCtx, copy: 'a' | 'b'): [number, number, number, number] | null {
  const src = ctx.graph.findSource(ctx.node.id, `${copy}_video_in`);
  if (!src) return null;
  const surface = ctx.surface(SYN_FRAME_W, SYN_FRAME_H);
  if (!surface) return null;
  const ctx2d = surface.getContext('2d', { willReadFrequently: true }) as
    | (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
    | null;
  if (!ctx2d) return null;

  const srcDomain = ctx.graph.node(src.nodeId)?.domain ?? 'audio';
  if (srcDomain === 'video') {
    // Cross-domain: render the source video module's FBO into the video
    // engine's shared drawing buffer, then sample that buffer.
    const image = ctx.engine.blitVideoNode(src.nodeId);
    if (!image) return null;
    try {
      ctx2d.clearRect(0, 0, SYN_FRAME_W, SYN_FRAME_H);
      ctx2d.drawImage(image as CanvasImageSource, 0, 0, SYN_FRAME_W, SYN_FRAME_H);
    } catch {
      return null;
    }
  } else {
    // Audio-domain mono-video source (RASTERIZE, WAVESCULPT.video_out, even
    // SYNESTHESIA's own raster): pull its drawFrame straight into the scratch.
    const vsrc = ctx.engine.videoSource(src.nodeId, src.portId);
    if (!vsrc?.drawFrame) return null;
    try {
      vsrc.drawFrame(surface);
    } catch {
      return null;
    }
  }
  try {
    const img = ctx2d.getImageData(0, 0, SYN_FRAME_W, SYN_FRAME_H);
    return videoChannelLevels(img.data);
  } catch {
    return null;
  }
}

/**
 * SYNESTHESIA — the per-copy video channel levels.
 *
 * ⚠ AND THE HALF THAT IS EASY TO MISREAD: this producer's output is not a
 * picture, so the pixel instruments that guard the other producers are blind to
 * it. `card-producer-lifetime.spec.ts` says so in its own prose and skips its
 * movement legs for this module. What proves this one is the LEVELS themselves
 * (`read('snapshot').levelsA/levelsB`) and the jacks downstream of them —
 * `synesthesia-video-mode.spec.ts` drives ACIDWARP into `a_video_in` and reads
 * the meters and a gate. A green pixel probe here would mean nothing.
 */
export const SYNESTHESIA_FRAME_PRODUCER: FrameProducer = {
  type: 'synesthesia',
  why:
    'in VIDEO mode the module\'s four lanes ARE the patched frame\'s R/G/B/Luma channels, and ' +
    'only the main thread can sample a frame — the worklet has no canvas. Nothing else writes ' +
    'video_levels_a/_b, so with no writer the module\'s 48 outputs FREEZE at the last sampled ' +
    'frame (or never leave zero) with every cable still visibly patched.',
  frame(ctx) {
    for (const copy of SYN_COPIES) {
      // ⚠ THE MODE CHECK COMES FIRST, AND IT IS A COST DECISION AS MUCH AS A
      // CORRECTNESS ONE. In AUDIO mode the worklet's own spectral bands are the
      // levels, so a push here would overwrite live analysis with a frame
      // nobody asked for — and `synVideoLevels` costs a blit plus a
      // `getImageData` readback per copy per frame, which is not something to
      // pay for a copy that is not looking at video at all.
      if (!synIsVideo(ctx, copy)) continue;
      const levels = synVideoLevels(ctx, copy);
      if (levels) ctx.engine.write(ctx.node, `video_levels_${copy}`, levels);
    }
  },
};

// ── TIMELORDE: the composited display, and the ONLY writer of it ─────────────
//
// TIMELORDE is an AUDIO module carrying a `video_in`/`video_out` pair so it can
// sit INLINE in a video chain, and both are consumed on the main thread for the
// same reason synesthesia's are: the audio engine has no AudioNode for a video
// port. The composite is the patched feed when one is connected, else the
// owner's owl painting with a colour-targeted beat boost on its eyes and border.
// It is pushed into the node as an `ImageBitmap`, and `video_out`'s own
// `drawFrame` blits the latest one downstream.
//
// ⚠ THIS PUSH IS THE SOLE WRITER OF THE NODE'S HELD FRAME, and the failure
// without it is the STALE-BITMAP shape rather than a black one: `drawFrame`
// keeps blitting the last frame anyone pushed, so a dead producer reads BRIGHT
// and FROZEN. MEASURED with the dock full view open on a promoted timelorde
// before `FACE_MOUNTS_PRODUCER` got its deny-by-default: the face canvas
// painting `nonBlack 47034/48400` — a perfect picture, from a card that was
// already gone. On a cold open with nothing pushed yet the same state paints the
// `#07090d` idle field instead, and a VRT baseline captured then would have
// pinned a black square forever. "Not black" cannot tell those apart; motion can.

/** The composite size. The card composited at this size and pushed a bitmap of
 *  it; both surfaces blit 1:1 from it, so it stays exactly what it was. */
const TL_DISPLAY_W = 220;
const TL_DISPLAY_H = 220;

/** The owner's folk-art OWL PAINTING — a bundled static asset served at the site
 *  root. Referenced by static path (the cadillac / media-burn precedent). */
const TL_OWL_SRC = '/img/timelorde-owl.png';

interface TimelordeState {
  owl?: FrameImage | null;
  owlPending?: boolean;
  beatAnchorMs?: number;
  prevRunning?: boolean;
  /** An `ImageBitmap` conversion is in flight — see the note at the push. */
  converting?: boolean;
}

function tlParam(ctx: FrameCtx, id: string, dflt: number): number {
  const raw = ctx.node.params?.[id];
  return typeof raw === 'number' ? raw : dflt;
}

/** Draw the LIVE feed patched into `video_in` into the scratch. True on success.
 *  Structurally identical to synesthesia's reader and for the same reason: a
 *  video-domain source is blitted through the engine's shared drawing buffer, an
 *  audio-domain mono-video source paints itself in through `drawFrame`. */
function tlDrawVideoFeed(
  ctx: FrameCtx,
  surface: FrameSurface,
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
): boolean {
  const src = ctx.graph.findSource(ctx.node.id, 'video_in');
  if (!src) return false;
  const srcDomain = ctx.graph.node(src.nodeId)?.domain ?? 'audio';
  if (srcDomain === 'video') {
    const image = ctx.engine.blitVideoNode(src.nodeId);
    if (!image) return false;
    try {
      ctx2d.clearRect(0, 0, TL_DISPLAY_W, TL_DISPLAY_H);
      ctx2d.drawImage(image as CanvasImageSource, 0, 0, TL_DISPLAY_W, TL_DISPLAY_H);
      return true;
    } catch {
      return false;
    }
  }
  const vsrc = ctx.engine.videoSource(src.nodeId, src.portId);
  if (!vsrc?.drawFrame) return false;
  try {
    vsrc.drawFrame(surface);
    return true;
  } catch {
    return false;
  }
}

/** The owl, with the colour-targeted beat boost. Until the image decodes we
 *  paint just the dark idle ground, so the display is never garbage. */
function tlDrawOwl(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  owl: FrameImage | null,
  pulse: number,
): void {
  ctx2d.clearRect(0, 0, TL_DISPLAY_W, TL_DISPLAY_H);
  ctx2d.fillStyle = '#07090d';
  ctx2d.fillRect(0, 0, TL_DISPLAY_W, TL_DISPLAY_H);
  if (!owl) return;
  const iw = owl.naturalWidth || owl.width;
  const ih = owl.naturalHeight || owl.height;
  if (!iw || !ih) return;
  // object-fit: contain — preserve the painting's aspect, centred.
  const scale = Math.min(TL_DISPLAY_W / iw, TL_DISPLAY_H / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  try {
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.drawImage(
      owl as unknown as CanvasImageSource,
      (TL_DISPLAY_W - dw) / 2,
      (TL_DISPLAY_H - dh) / 2,
      dw,
      dh,
    );
  } catch {
    return; // not yet usable (decode race) — the idle ground stands
  }
  // ⚠ ONLY WHEN PULSING, which is what keeps the reduced-motion frame
  // deterministic: `pulse` is pinned to 0 there, so the captured picture is the
  // bare owl and the per-pixel boost never runs.
  if (pulse <= 0) return;
  let frame: ImageData;
  try {
    frame = ctx2d.getImageData(0, 0, TL_DISPLAY_W, TL_DISPLAY_H);
  } catch {
    return; // tainted/locked — the owl still shows
  }
  applyBeatBoost(frame.data, pulse);
  ctx2d.putImageData(frame, 0, 0);
}

/**
 * TIMELORDE — the composited display frame.
 *
 * ⚠ THE OWL IS AWAITED ON *DECODE*, NOT ON *LOAD*, and the distinction is
 * measured. The card flipped its ready flag in `onload`, which fires when the
 * bytes arrive and not when the bitmap is rasterised — so under
 * `prefers-reduced-motion` (the VRT capture) exactly one frame is painted and
 * whatever raster state Chromium happened to be in is LATCHED into it forever.
 * 13 of 20 separate processes failed unmasked on that. `env.loadImage` resolves
 * on decode; see its note in `./node-frame-producers`.
 */
export const TIMELORDE_FRAME_PRODUCER: FrameProducer = {
  type: 'timelorde',
  why:
    "the composited display is pushed into the node and `video_out`'s own drawFrame blits the " +
    'LATEST one — so this push is the only writer of what the module passes downstream. With no ' +
    'writer the port does not go black, it FREEZES on the last bitmap anyone pushed (measured: a ' +
    'face painting nonBlack 47034/48400 from a card that was already gone), or serves the ' +
    '#07090d idle field on a cold open.',
  frame(ctx) {
    const state = ctx.state as TimelordeState;

    // The owl, once per node. `loadImage` resolves on DECODE.
    if (state.owl === undefined && !state.owlPending) {
      state.owlPending = true;
      void ctx.env.loadImage(TL_OWL_SRC).then((img) => {
        state.owl = img;
        state.owlPending = false;
      });
    }

    const bpm = tlParam(ctx, 'bpm', 120);
    const running = tlParam(ctx, 'running', 1) >= 0.5;

    // Re-anchor the beat phase on a stopped→running transition, so the flash
    // lands on the downbeat after a start rather than at an arbitrary offset.
    if (running && state.prevRunning === false) state.beatAnchorMs = ctx.env.nowMs();
    state.prevRunning = running;
    if (state.beatAnchorMs === undefined) state.beatAnchorMs = ctx.env.nowMs();

    const reduced = ctx.env.prefersReducedMotion();

    // ⚠ THE REDUCED-MOTION ARM IS A CONVERGENCE, NOT A ONE-SHOT, AND THAT WAS A
    // LIVE BUG. Pushing exactly once means a write that lands before the engine
    // handle exists — or on a handle that is then replaced — is lost FOREVER,
    // and `video_out` serves the idle field for the rest of the session.
    // MEASURED on a default rack under `reducedMotion: 'reduce'`, with the card
    // mounted and its own canvas carrying the owl at `nonBlack 47034/48400`:
    // `video_out` read `nonBlack 0/3072, maxLuma 9`. Ordinary racks never saw it
    // because the live loop re-pushes every frame and the loss self-heals.
    // So: ask the node whether it HOLDS a frame, and re-do the work only while
    // it does not. One boolean read per frame, no allocation, no repaint — and
    // it heals a replaced handle too, which a one-shot retry could not.
    if (reduced && ctx.engine.read(ctx.node, 'hasDisplayFrame') === 1) return;

    const pulse = reduced
      ? 0
      : beatPulse({ bpm, running, nowMs: ctx.env.nowMs(), anchorMs: state.beatAnchorMs });

    const surface = ctx.surface(TL_DISPLAY_W, TL_DISPLAY_H);
    if (!surface) return;
    const ctx2d = surface.getContext('2d') as
      | (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
      | null;
    if (!ctx2d) return;

    // The feed wins; the owl is the fallback. ⚠ AND THE OWL IS COMPOSITED EVEN
    // WHEN A SURFACE SHOWS "wizard off" — that switch hides the on-card picture,
    // it does not stop the module emitting one, so `video_out` still carries a
    // coherent frame. `wizardDisplayMode` is the surfaces' business, not this
    // one's.
    if (!tlDrawVideoFeed(ctx, surface, ctx2d)) tlDrawOwl(ctx2d, state.owl ?? null, pulse);

    // ⚠ ONE CONVERSION IN FLIGHT AT A TIME. `createImageBitmap` is async, and
    // the card's version fired one per frame unguarded — fine while conversion
    // beats the frame budget, and an unbounded queue of decoded bitmaps when it
    // does not. This cannot reduce the steady-state rate (one per frame is the
    // ceiling either way); it only refuses to START a second conversion while
    // the first is still running, which is exactly when you want fewer.
    const make = ctx.env.createImageBitmap;
    if (!make || state.converting) return;
    state.converting = true;
    void make(surface)
      .then((bmp) => {
        state.converting = false;
        // The handle CLOSES the previous bitmap on write (timelorde.ts), so the
        // only leak to worry about is a node that left mid-conversion — the
        // registry has already dropped it, and the write is a no-op there.
        ctx.engine.write(ctx.node, 'displayFrame', bmp);
      })
      .catch(() => {
        state.converting = false;
      });
  },
};

/**
 * RASTERIZE — the combined draw params AND the painter's advance (legacy-removal
 * S1.5, the fourth producer departure and the first with TWO duties in one body).
 *
 * ⚠ THE PUSH IS SCOPE'S, VERBATIM IN SHAPE AND FOR THE SAME REASON: `addEdge`
 * connects a same-domain cv cable to the AudioParam and never calls `setParam`,
 * so the painter's four display params reach a patched cable only through this
 * `write(node,'cvCombined')`. Stop it and a param under CV LATCHES at its last
 * modulated value forever (`cv-shadow` clears `combined` only on a knob move) —
 * on a picture that keeps moving, so nothing about it looks broken. The
 * correction history lives on `dom-source-modules.ts` ("degrades to the knob"
 * was the wrong story, in the direction that matters).
 *
 * ⚠ THE READ IS NOT A LEFTOVER — IT IS THE MODULE'S HEARTBEAT. rasterize's
 * painter is advanced INSIDE `read('imageData')` (`advanceOncePerFrame`), and
 * the cross-domain bridge only pulls `drawFrame` when a downstream VIDEO edge
 * exists. So with nothing patched downstream, whoever holds this loop is the
 * only thing advancing the raster — that used to be the card (and the dock
 * body, a second copy), and gating it on a mount is the #1720/#1721 freeze
 * class. The advance is deduped on the module's own 8 ms guard, so this read,
 * a viewer's read and the bridge's pull coalesce instead of racing the cursor
 * at 2×.
 *
 * ⚠ PUSH BEFORE READ (#1664). The painter runs inside the read, so the push has
 * to land first or the frame is painted with last frame's CV — the bug wearing
 * a fix. `rasterize-face-model.test.ts` holds this order at source level, HERE,
 * because the surfaces no longer carry either half.
 */
export const RASTERIZE_FRAME_PRODUCER: FrameProducer = {
  type: 'rasterize',
  why:
    'the module owns no AnalyserNode per display param, so a patched cv cable reaches the ' +
    "painter only through `write(node,'cvCombined')` — and the painter itself is advanced " +
    "INSIDE `read('imageData')`, which the bridge only pulls when a downstream video edge " +
    'exists. With no owner the raster freezes when nothing is patched downstream, and a param ' +
    'under CV latches at its last modulated value with the picture still moving.',
  frame({ node, engine }) {
    // ALL FOUR, EVERY FRAME, UNCONDITIONALLY — scope's argument, unabridged: a
    // param whose cable has just been pulled has to be re-written with the bare
    // knob to come back, so sampling "only the patched ports" would be wrong on
    // exactly the frame it saves nothing.
    const combined: Record<string, number> = {};
    for (const p of rasterizeDef.params) {
      const v = engine.readParam(node, p.id);
      if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
    }
    engine.write(node, 'cvCombined', combined);
    // THE ADVANCE. The returned frame is deliberately dropped: painting a
    // surface is a VIEW's job (the card and the dock body blit this same read
    // on their own lifetime); this seam only guarantees the raster moves.
    engine.read(node, 'imageData');
  },
};

/**
 * FOXY — the realtime bridge tick, which is what makes the module AUDIBLE.
 *
 * ⚠ THIS ONE IS NOT ABOUT A PICTURE. FOXY's audio path is a `wavecel` worklet
 * fed by a wavetable the factory REBUILDS on `bridgeTick()`: paint the three
 * rasters, compute the 3-axis field, build and post the table. Nothing else
 * calls it. A SURFACE called it as a side effect of asking for its previews —
 * its rAF read `rasterImageDataA/B/C`, and the factory's getter for those keys
 * runs `bridgeTick()` before returning the image, under a comment that said
 * exactly that ("Drive the bridge once, then read the cached previews"). So the
 * module's SOUND had a component's lifetime.
 *
 * MEASURED 2026-09-04, FOXY -> SCOPE.ch1, one patch, the surface mounted and
 * not: maxPeak 1.0000 with it, 0.0000 without it over a 6 s window with 201
 * readings. Not quiet — SILENT. And the module is not obscure about it: with
 * that surface gone a rack with a FOXY in it made no sound at all, which is why
 * this is a live production defect rather than a consequence of the removal. It
 * surfaced only when the per-port emit sweep stopped mounting the surface that
 * happened to be pumping it.
 *
 * Driving it from here is #1587's rule applied to the case that names it best:
 * PRODUCE (rebuild the table the worklet plays) has to run while the NODE
 * exists; PAINT (blit the three raster previews) belongs to whoever is looking.
 * The read below returns an ImageData that is deliberately DROPPED — the tick
 * is the point, the picture is the caller's business, and the factory's own
 * `BRIDGE_MS` throttle dedupes this read against a surface's.
 */
export const FOXY_FRAME_PRODUCER: FrameProducer = {
  type: 'foxy',
  why:
    "the wavetable the module's `wavecel` worklet plays is rebuilt only by the factory's " +
    "`bridgeTick()`, and the only way to reach that from outside is to READ one of the raster " +
    'keys — which a preview-drawing surface used to do as a side effect. With no such surface ' +
    'the tick never runs, the table is never posted and the module is SILENT: measured maxPeak ' +
    '1.0000 with that surface mounted against 0.0000 without it, same patch.',
  frame({ node, engine }) {
    // `tick`, not `rasterImageDataA`. The factory answers BOTH keys by running
    // `bridgeTick()` first, but `tick` returns `undefined` where the raster keys
    // return an `ImageData` — and this seam has nothing to draw it on. A surface
    // had to ask for a picture because it was going to blit one; the node does
    // not, so it asks for the tick by name and copies nothing.
    engine.read(node, 'tick');
  },
};

/**
 * The producers this seam owns.
 *
 * ⚠ ORDER IS NOT SIGNIFICANT and membership is DERIVED, never re-typed: both
 * `NODE_FRAME_PRODUCER_TYPES` (below) and the disjointness gate in
 * `dom-source-modules.test.ts` read this array, so a producer added here enters
 * every consumer at once and cannot be half-registered.
 */
export const FRAME_PRODUCERS: readonly FrameProducer[] = [
  SCOPE_FRAME_PRODUCER,
  SYNESTHESIA_FRAME_PRODUCER,
  TIMELORDE_FRAME_PRODUCER,
  RASTERIZE_FRAME_PRODUCER,
  FOXY_FRAME_PRODUCER,
];

/**
 * The module TYPES whose per-frame producer is owned by the NODE.
 *
 * DERIVED from the list above — never a second literal. `dom-source-modules.ts`
 * asserts this set is DISJOINT from `CARD_PRODUCER_LANE_TYPES` and that every
 * departure from that set is owned here, so a producer extraction cannot land
 * half-done in either direction.
 *
 * ⚠ EXPORTED FROM *THIS* FILE, NOT FROM THE REAL-DOM SINGLETON, and that is a
 * dependency decision rather than tidiness: a gate that only wants to ask "who
 * owns this module" should not have to import `$lib/graph/store` and the engine
 * adapters to find out. `./node-frame-producers` re-exports it for callers that
 * already hold the singleton.
 */
export const NODE_FRAME_PRODUCER_TYPES: ReadonlySet<string> =
  frameProducerTypes(FRAME_PRODUCERS);
