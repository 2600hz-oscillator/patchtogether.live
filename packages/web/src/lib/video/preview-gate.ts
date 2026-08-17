// packages/web/src/lib/video/preview-gate.ts
//
// SHOULD A CARD REPAINT ITS PREVIEW THIS FRAME? — the pure decision behind
// `VideoEngine.blitOutputForPreview` (#1802).
//
// ── the three costs, and why they are not one cost ─────────────────────────
//
// Every mounted video card runs an unconditional rAF that does
// `blitOutputToDrawingBuffer(id)` then `drawImage(engine.canvas, …)`. That is
// three separable bills:
//
//   1. the UPSTREAM GL RENDER, kept alive because the blit marks the node
//      WATCHED and a watched node is a pull root;
//   2. the CARD's `drawImage` from a WebGL canvas, which forces a
//      synchronisation snapshot and is the expensive one;
//   3. the per-frame rAF CALLBACK itself.
//
// MEASURED on the owner's rack shape (#1801), real GPU, 240 scheduler-tick
// arrivals per phase, `VideoEngine.step` as a share of main-thread wall time:
//
//   cards ON-SCREEN, every frame            54.6 %   tick p99 17.5 ms
//   cards ON-SCREEN, drawImage no-op'd      21.2 %   tick p99  3.5 ms
//   cards OFF-SCREEN, every frame            0.19 %  tick p99  5.0 ms
//   cards OFF-SCREEN, drawImage no-op'd      0.23 %  tick p99  5.0 ms
//
// Two conclusions, and they point in opposite directions from what #1802
// assumed:
//
//   * OFF-SCREEN is ALREADY nearly free. Sink-driven pull evaluation has
//     already stopped cost (1) — measured, every node's `framesDrawn` delta is
//     exactly 0 — and a `drawImage` of a canvas nothing is drawing into is
//     cheap, because there is no pipeline to synchronise with. Gating the
//     off-screen blit is worth ~0.04 % of the main thread. It is still worth
//     doing, but for CORRECTNESS, not for milliseconds (see below).
//   * ON-SCREEN is where the whole bill is, and you cannot gate away a preview
//     the user is looking at. What you CAN do is repaint it less often:
//
//       every frame  54.6 %   every 2nd  28.1 %   every 4th  24.7 %
//
//     Halving the repaint rate halves the main-thread cost and takes tick p99
//     from 17.5 ms to 3.8 ms. The knee is at 2 — going to a quarter buys
//     almost nothing more. That is what {@link PREVIEW_FPS} exists for.
//
// ── the CORRECTNESS half: "off" must mean "not there" ─────────────────────
//
// MEASURED: a BACKDRAFT card that is not in full-frame mode skips its blit but
// still calls `markWatched(id)` every frame. With its output patched NOWHERE,
// `toybox → backdraft` still drew 481 frames in 4 s — a chain rendering for a
// picture that is presented on no surface at all. A card that is not showing
// anything must not be an observer, and the way to stop being one is to stop
// blitting, because the blit IS the watch mark.
//
// ── what is deliberately NOT gated here ────────────────────────────────────
//
// A LEASED node bypasses every gate. `acquireRenderLease` is what true
// fullscreen, present-on-second-display and full-frame already take, so
// "presenting on a surface that outlives the card's viewport rect" is DERIVED
// from engine state rather than re-declared per card. A lease means a human is
// looking at the real picture: no visibility gate, no cadence cap.
//
// PURE + framework-free: no timers, no globals, no `performance`. The caller
// passes the clock in, so this unit-tests deterministically.

/**
 * Target repaints per second for an ON-CARD preview.
 *
 * ⚠ THIS IS A LOOK CHANGE, and it is a POLICY THRESHOLD on a measured
 * quantity, not a count of anything. 30 rather than 24 or 20 because the
 * measurement above puts the knee at "half of a 60 Hz display" — the whole
 * saving is already banked at every-2nd-frame, and going lower spends
 * smoothness for almost nothing.
 *
 * It does NOT apply to a leased (presenting) surface — fullscreen, the
 * projector popup and full-frame all repaint every frame, which is where
 * anyone would actually notice.
 *
 * There is in-repo precedent: `VideoTileThumb.svelte` has capped its lane
 * thumbnails since it shipped, for exactly this reason.
 */
export const PREVIEW_FPS = 30;

/** Minimum wall-clock gap between two preview repaints of the same node,
 *  MILLISECONDS. Derived from {@link PREVIEW_FPS} so the two cannot drift.
 *
 *  ⚠ MILLISECONDS is the right unit HERE, and this is not the "count frames,
 *  never ms" case: that rule is about renderer-dependent WAITS in e2e, where a
 *  wall-clock budget silently becomes a different frame count per machine.
 *  This is the opposite — a PRODUCT-side cadence that must be the same real
 *  rate on a 60 Hz laptop and a 144 Hz monitor, which is precisely what a
 *  frame count would fail to be. */
export const PREVIEW_MIN_INTERVAL_MS = 1000 / PREVIEW_FPS;

/** Why a preview repaint was allowed or refused. Reported rather than reduced
 *  to a boolean so a probe can tell "refused because off-screen" from
 *  "refused because it already painted 4 ms ago" — two states that look
 *  identical from a repaint count and need opposite investigations. */
export type PreviewDecision = 'blit' | 'skip:offscreen' | 'skip:throttled';

export interface PreviewGateInput {
  /** Card viewport visibility as the engine sees it. `undefined` = UNKNOWN,
   *  which FAILS OPEN (treated as visible) — the same rule pull evaluation
   *  uses, and for the same reason: a card whose element the observer has not
   *  seen yet must not be silently blanked. */
  readonly cardVisible: boolean | undefined;
  /** Does this node hold a hard render lease (fullscreen / projector /
   *  full-frame)? A lease bypasses BOTH gates. */
  readonly leased: boolean;
  /** When this node last repainted a preview, on the caller's clock. `null` =
   *  never. */
  readonly lastPreviewAtMs: number | null;
  /** Now, on the caller's clock. */
  readonly nowMs: number;
  /** Minimum gap between repaints. Defaults to {@link PREVIEW_MIN_INTERVAL_MS};
   *  pass 0 to disable the cadence cap (the kill switch's shape). */
  readonly minIntervalMs?: number;
}

/**
 * Decide whether a card may repaint its own node's preview this frame.
 *
 * Order matters: VISIBILITY is checked before CADENCE. An off-screen card must
 * report `skip:offscreen` even if it is also past its cadence window, because
 * the two carry different meanings for the caller — off-screen means "stop
 * being an observer of this node", throttled means "you are still watching,
 * just not this frame".
 */
export function previewDecision(input: PreviewGateInput): PreviewDecision {
  if (input.leased) return 'blit';
  if (input.cardVisible === false) return 'skip:offscreen';
  const min = input.minIntervalMs ?? PREVIEW_MIN_INTERVAL_MS;
  if (min <= 0) return 'blit';
  if (input.lastPreviewAtMs === null) return 'blit';
  // `>=` and not `>`: a repaint exactly one interval later is ON cadence, and
  // rejecting it would make the effective rate drift below the target on a
  // display whose frame period divides evenly into it.
  return input.nowMs - input.lastPreviewAtMs >= min ? 'blit' : 'skip:throttled';
}
