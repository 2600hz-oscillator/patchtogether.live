// packages/web/src/lib/video/pull-eval.ts
//
// SINK-DRIVEN PULL EVALUATION for the video engine (stack-study adoption
// item 1 — see .myrobots/stack-study-compare-B-native-performance.md §"quick
// wins": "walk backward from OUTPUT cards / visible previews / RECORDERBOX /
// patched consumers; skip everything else").
//
// The VideoEngine used to render EVERY node each rAF in topo order ("push"
// evaluation). On real hardware the video pipeline at ~21fps idle saturates
// the main thread and starves the audio output buffer (the owner's
// drag-audio-glitch, memory `clock-perf-glitch-output-underrun`). Pull
// evaluation makes laziness an ENGINE INVARIANT instead of per-module
// discipline: each frame the engine computes the set of nodes that can
// actually be OBSERVED this frame — the reverse-reachable subgraph from the
// frame's ROOTS — and draws only those.
//
// Roots are:
//   1. WATCHED nodes — something presented or probed the node's output
//      recently (an OUTPUT card blit, an on-card preview blit, a card polling
//      `read()`, a test reading `outputTexture()`), AND the node's card is not
//      known-offscreen (see VideoEngine.setCardVisibility — fail-open when
//      unknown).
//   2. LEASED nodes — an explicit hard watch that ignores card visibility
//      (VideoOutCard's true-fullscreen / present-on-second-display modes,
//      where the presented surface outlives the card's viewport rect).
//   3. SIDE-EFFECTFUL nodes — modules whose draw() has observable effects
//      beyond their texture: anything publishing live audio (`audioSources`:
//      DOOM, BLOOD, NIBBLES, GIBRIBBON, the video players, MANDELBULB's
//      sonification…), consuming audio (`audioInputs`: RECORDERBOX,
//      MILKDROP, GRAPHICEQ), publishing discrete pulses (`subscribePulse`),
//      or explicitly flagged `pullExempt` on the def. These stay live while
//      unwatched — their SIMULATION must keep running (a multiplayer DOOM
//      can't pause because nobody on this client is looking at it).
//
// Everything else — an unpatched generator chain, a subgraph feeding only an
// offscreen preview — costs ZERO render work.
//
// This module is the PURE core (flag + reachability walk) so it unit-tests
// without a GL context; the engine owns the bookkeeping (watch marks,
// visibility, leases) and calls into here each frame.

/** Runtime kill-switch for pull evaluation. Default ON. Precedence (first
 *  match wins), mirroring the Fix E worker flag reader:
 *   1. `globalThis.__videoPullEval` — `false` force-disables, `true` forces on
 *      (e2e flips this via addInitScript; a dev pokes the console).
 *   2. URL param `?pulleval=0`/`=false` → OFF, `=1`/`=true` → ON (reviewer A/B
 *      by link, no console).
 *   3. build flag `VITE_VIDEO_PULL_EVAL === 'false'` → OFF.
 *  Otherwise ON (the production default). */
export function isPullEvalOn(): boolean {
  const override = (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval;
  if (override === true) return true;
  if (override === false) return false;
  try {
    if (typeof location !== 'undefined' && location.search) {
      const v = new URLSearchParams(location.search).get('pulleval');
      if (v === '1' || v === 'true') return true;
      if (v === '0' || v === 'false') return false;
    }
  } catch {
    // location / URLSearchParams unavailable (SSR / odd realm) — fall through.
  }
  try {
    if (
      (import.meta as unknown as { env?: Record<string, string> }).env
        ?.VITE_VIDEO_PULL_EVAL === 'false'
    ) {
      return false;
    }
  } catch {
    /* import.meta.env unavailable — default ON */
  }
  return true;
}

/**
 * Compute the ACTIVE set: every node reverse-reachable from `roots` through
 * `incomingSources` (target → its upstream source node ids). Roots are always
 * included. Nodes outside the returned set are safe to skip this frame — no
 * observable output depends on them.
 *
 * Pure + allocation-light: one Set + one explicit work stack, no recursion
 * (a 1000-node chain must not blow the call stack).
 */
export function computeActiveSet(
  roots: Iterable<string>,
  incomingSources: (nodeId: string) => Iterable<string>,
): Set<string> {
  const active = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) {
    if (!active.has(r)) {
      active.add(r);
      stack.push(r);
    }
  }
  while (stack.length) {
    const id = stack.pop()!;
    for (const src of incomingSources(id)) {
      if (!active.has(src)) {
        active.add(src);
        stack.push(src);
      }
    }
  }
  return active;
}
