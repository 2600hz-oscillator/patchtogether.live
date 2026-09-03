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

import { scopeDef } from '$lib/audio/modules/scope';
import { videoChannelLevels } from '../../../../../dsp/src/lib/synesthesia-dsp';
import {
  frameProducerTypes,
  type FrameCtx,
  type FrameProducer,
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
