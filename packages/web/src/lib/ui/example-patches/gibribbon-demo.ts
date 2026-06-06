// packages/web/src/lib/ui/example-patches/gibribbon-demo.ts
//
// "GIBRIBBON (game demo)" — the bundled demo patch that DRIVES the GibRibbon
// game module (PR #620) from a sequenced MACROOSCILLATOR voice analysed by
// SYNESTHESIA. The full chain is:
//
//   TIMELORDE ──2x──▶ MACSEQ ──pitch/gate/modelcv──▶ MACROOSCILLATOR
//        │ 1x           │ gate                              │ out
//        │              │                                   ▼
//        │              │                            SYNESTHESIA (copy A)
//        │              │                   a_band{1..4}_env_slow ─┐
//        └──────────────┴───────────────────────────────────────▶ GIBRIBBON
//                                       (1x→clock, gate→gate, env→cv1..cv4)
//
// Same shape as glitches.ts / media-burn.ts: the envelope is built offline by
// scripts/build-gibribbon-demo-envelope.mjs and loaded through the canonical
// `loadEnvelopeIntoStore` path so we get per-module migrations on load and the
// identical code path to the user-facing Save/Load buttons.
//
// The four SLOW SYNESTHESIA envelopes on copy A drive GibRibbon's cv1..cv4,
// which map (via GIB_TUNING.cvEventMap) to loop/jump/imp/zombie events; the
// MACSEQ gate biases which channel spawns each beat, and the TIMELORDE 1× tick
// is GibRibbon's scroll clock. See gibribbon-events.ts for the tuning that
// turns this rhythm into a game-appropriate event rate.

import {
  type PatchEnvelope,
  parseEnvelope,
  loadEnvelopeIntoStore,
  type LoadResult,
} from '$lib/graph/persistence';
import type { ydoc as Ydoc, patch as Patch } from '$lib/graph/store';
// Vite imports JSON natively as a parsed object.
import rawEnvelope from './gibribbon-demo.imp.json';

export const GIBRIBBON_DEMO_ENVELOPE_RAW: unknown = rawEnvelope;

let _validated: PatchEnvelope | null = null;
export function getGibribbonDemoEnvelope(): PatchEnvelope {
  if (_validated) return _validated;
  _validated = parseEnvelope(JSON.stringify(GIBRIBBON_DEMO_ENVELOPE_RAW));
  return _validated;
}

/**
 * Load the GIBRIBBON game demo into the live store. Same contract as
 * `loadEnvelopeIntoStore` — clears whatever's currently in the rack + replays
 * the envelope's 5 nodes + 11 edges (with per-module migrations applied).
 *
 * Once live, TIMELORDE free-runs (running=1) and MACSEQ free-runs
 * (isPlaying=1), so the sequenced voice → SYNESTHESIA envelopes → GibRibbon
 * event stream starts immediately. The player drives the ABXY buttons.
 */
export function loadGibribbonDemo(
  liveYdoc: typeof Ydoc,
  livePatch: typeof Patch,
): LoadResult {
  const envelope = getGibribbonDemoEnvelope();
  return loadEnvelopeIntoStore(envelope, liveYdoc, livePatch);
}
