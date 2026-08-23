// packages/web/src/lib/video/worker/worker-eligibility.ts
//
// WHICH VIDEO MODULES CAN RENDER OFF THE MAIN THREAD — DERIVED, never typed.
//
// #1811 asks for a per-module disposition: moved / cannot move + the structural
// reason / moved with a named caveat. Writing that as a list of module names
// would be a hand-maintained population that goes stale the moment anyone adds
// a module — the exact construct CLAUDE.md forbids. So the disposition is
// COMPUTED from the def's own I/O contract plus the two DERIVED lane sets the
// workflow layer already maintains, and the gate
// (`worker-eligibility.test.ts`) asserts the computation against the live
// registry in BOTH directions.
//
// ── the blockers are properties of the WORKER's contract, not opinions ──────
//
// `worker-engine.ts` implements a deliberately small slice of
// `VideoEngineContext`. Each blocker below names one thing that slice does not
// have, and each is checkable from the def alone:
//
//   video-input        `getInputTexture` ALWAYS returns null in the worker —
//                      there are no cross-thread input textures and no
//                      worker-side edges. A module with a video input would
//                      render as if UNPATCHED, which is not a degradation, it
//                      is a different picture. This is the blocker that owns
//                      the overwhelming majority of the registry, and closing
//                      it (worker-side edges between worker-resident nodes) is
//                      the single change that would unlock effect chains.
//
//   multi-video-output the return protocol is ONE ImageBitmap per node, drained
//                      into ONE main-GL texture. A module with a second video
//                      output serves it through `read('outputTexture:<port>')`,
//                      which the proxy can only answer by materialising the
//                      MAIN-THREAD factory — so the module would render TWICE
//                      per frame (worker + main) and be strictly slower than
//                      not migrating it at all.
//
//   audio-port         the worker realm has no AudioContext (`ctx.audioCtx` is
//                      undefined), so a module that publishes or consumes audio
//                      cannot exist there.
//
//   dom-source         the CARD owns a real <video>/<img>, hands it to
//                      `attachExternalSource`, AND THE ENGINE KEEPS IT — wiring
//                      per-frame delivery (rVFC, the texture uploader, a
//                      keep-alive, a retained `mediaEl`). A live DOM element is
//                      main-thread by definition. Membership comes from
//                      `DOM_SOURCE_LANE_TYPES`, which is derived from BOTH
//                      halves: the card grep and the engine-side attach body.
//                      ⚠ The second half is why `frametable` and `videocube`
//                      are NOT here. They attach a one-shot atlas the next draw
//                      detiles and drops, so nothing main-thread is pinned by
//                      it. Both remain BLOCKED regardless — frametable on
//                      `video-input`, videocube on `video-input` +
//                      `multi-video-output` + `audio-port` — so dropping
//                      `dom-source` moved neither module's disposition.
//
//   card-producer      the CARD's own rAF IS the producer of the picture (or of
//                      the engine-visible state). Membership comes from
//                      `CARD_PRODUCER_LANE_TYPES`, also derived.
//
// ── why the two lane sets are INJECTED rather than imported ────────────────
//
// They live under `$lib/ui/workflow/`. Importing UI from `$lib/video/` would
// invert the layering, and — worse — anything the render worker's import graph
// can reach must stay DOM-free or the worker bundle breaks. Taking them as
// arguments keeps this module pure, keeps it unit-testable without the UI
// layer, and makes the gate the only place the real sets are named.
//
// ⚠ WHAT THIS CANNOT SEE, stated inside the classifier because a gate that
// does not declare its own blind spots is how four green gates were all blind:
// it reads the DEF, so it cannot see what the FACTORY does. A module with a
// clean contract can still touch `document`, `getUserMedia`, `localStorage`, a
// `window.__vrtSeed` harness hook, or a card-pushed canvas — every one of
// those is a real blocker and NONE of them is visible here. That is exactly
// why promotion is not automatic: `derivedBlockers(def).length === 0` makes a
// module a CANDIDATE, and a human either promotes it or records why not in the
// gate's holdout list, where the reason is required BY THE TYPE.

import type { VideoModuleDef } from '$lib/video/module-registry';
import { isVideoCableType } from '$lib/graph/types';

/** A structural reason a module's GL compute cannot run in the render worker. */
export type WorkerBlocker =
  | 'video-input'
  | 'multi-video-output'
  | 'audio-port'
  | 'dom-source'
  | 'card-producer';

// PICTURE-CARRYING PORTS come from the graph layer's own `isVideoCableType`,
// not a local list. A local list is how the first pass of this analysis went
// wrong: it matched only `'video'` and therefore classified `colorizer`,
// `lines` and `shapedramps` — all `mono-video` CONSUMERS — as leaf sources
// with no input, which would have "migrated" three effects into a worker that
// hands them a null input texture. Deriving from the shared predicate means
// `keys` and `image` cables are covered too, and a fifth video cable type
// cannot appear without this classifier seeing it.

/** Port types that put a module on the AudioContext.
 *
 *  ⚠ ASYMMETRIC BY DESIGN, and the asymmetry is the whole subtlety:
 *
 *  * an audio-family INPUT or OUTPUT is obviously AudioContext-bound;
 *  * a CV-family OUTPUT (`cv`/`pitch`/`gate`) on a VIDEO module is TOO. The
 *    video handle has to publish a real `AudioNode` for it (`audioSources`,
 *    built from `ctx.audioCtx`), which cannot exist in the worker realm.
 *    GIBRIBBON is the case that proved it: its contract shows no `audio` port
 *    at all, so an audio-family-only check classified it as a clean leaf
 *    source — while its factory builds six ConstantSourceNodes.
 *  * a CV-family INPUT is NOT a blocker. Those are resolved by the MAIN
 *    thread's CV bridge, which samples the analyser and calls `setParam` —
 *    already forwarded to worker nodes over RPC. `modsignal` (the
 *    video-domain CV cable) likewise. */
const AUDIO_PORT_TYPES: ReadonlySet<string> = new Set(['audio']);
const CV_FAMILY_TYPES: ReadonlySet<string> = new Set(['cv', 'pitch', 'gate']);

export interface EligibilityInputs {
  /** `DOM_SOURCE_LANE_TYPES` — the card owns a media element. */
  domSourceTypes: ReadonlySet<string>;
  /** `CARD_PRODUCER_LANE_TYPES` — the card's rAF is the producer. */
  cardProducerTypes: ReadonlySet<string>;
}

/**
 * Every structural blocker this def carries, in a stable order so two callers
 * comparing dispositions never differ on ordering alone. Empty = the module is
 * a CANDIDATE for the worker on its CONTRACT (see the blind-spot note above —
 * that is not the same as "safe").
 */
export function derivedBlockers(
  def: VideoModuleDef,
  inputs: EligibilityInputs,
): WorkerBlocker[] {
  const blockers: WorkerBlocker[] = [];
  if (def.inputs.some((p) => isVideoCableType(p.type))) {
    blockers.push('video-input');
  }
  // NOT a population count: this is "does a SECOND picture port exist", a
  // structural property of the return protocol (one ImageBitmap per node), not
  // a tally of how many of something there are.
  const pictureOuts = def.outputs.filter((p) => isVideoCableType(p.type));
  if (pictureOuts.length > 1) blockers.push('multi-video-output');
  if (
    def.inputs.some((p) => AUDIO_PORT_TYPES.has(String(p.type))) ||
    def.outputs.some((p) => AUDIO_PORT_TYPES.has(String(p.type))) ||
    def.outputs.some((p) => CV_FAMILY_TYPES.has(String(p.type)))
  ) {
    blockers.push('audio-port');
  }
  if (inputs.domSourceTypes.has(String(def.type))) blockers.push('dom-source');
  if (inputs.cardProducerTypes.has(String(def.type))) blockers.push('card-producer');
  return blockers;
}

/** Where a def says its GL compute runs. `undefined` means `'main'`; stated
 *  once here so no caller re-implements the default. */
export function declaredLocus(def: VideoModuleDef): 'main' | 'worker' | 'worker-experimental' {
  return def.renderLocus ?? 'main';
}

/** One module's disposition, in the shape #1811 asks for. */
export interface Disposition {
  type: string;
  locus: 'main' | 'worker' | 'worker-experimental';
  blockers: WorkerBlocker[];
  /** MOVED — renders in the worker in the production default flag state.
   *  CANDIDATE — no contract blocker, still on main (a holdout; see the gate).
   *  EXPERIMENTAL — a worker path exists but has declared parity gaps.
   *  BLOCKED — at least one structural blocker. */
  state: 'MOVED' | 'EXPERIMENTAL' | 'CANDIDATE' | 'BLOCKED';
}

export function disposition(def: VideoModuleDef, inputs: EligibilityInputs): Disposition {
  const blockers = derivedBlockers(def, inputs);
  const locus = declaredLocus(def);
  const state: Disposition['state'] =
    locus === 'worker'
      ? 'MOVED'
      : locus === 'worker-experimental'
        ? 'EXPERIMENTAL'
        : blockers.length === 0
          ? 'CANDIDATE'
          : 'BLOCKED';
  return { type: String(def.type), locus, blockers, state };
}
