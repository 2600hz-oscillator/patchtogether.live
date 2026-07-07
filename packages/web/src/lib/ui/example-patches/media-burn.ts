// packages/web/src/lib/ui/example-patches/media-burn.ts
//
// "MEDIA BURN" — homage to the 1975 Ant Farm performance piece. Loads
// 15 PICTUREBOX tiles arranged 5x3 flush (re-assembling the iconic
// photo of the Cadillac driving into the stacked TVs) plus a CADILLAC
// meta-node positioned so the car starts demolishing the rightmost
// column exactly 1 second after load.
//
// Same shape as glitches.ts: the envelope was built offline by
// scripts/build-media-burn-envelope.mjs (removed in the LoC hygiene sweep —
// recover it from git history at the deleting commit if the envelope ever
// needs regenerating) and is loaded through the canonical
// `loadEnvelopeIntoStore` path so we automatically get:
//   - per-module migrations on load
//   - identical code path to the user-facing Save/Load buttons
//   - PICTUREBOX tile bytes carried as `data.imageBytes` (already-
//     populated on load — no extra wiring; PictureboxCard's $effect
//     decodes whenever the bytes change)
//
// CADILLAC determinism: the envelope deliberately omits
// `data.spawnedAtMs`. The overlay's `?? Date.now()` fallback
// (CadillacOverlay.svelte) makes load-time === spawn-time, so the
// "1 second to first hit" beat is reproducible every load. See
// `media-burn-math.ts` for the layout + start-x derivation and the
// pinned unit test in media-burn-math.test.ts.

import {
  type PatchEnvelope,
  parseEnvelope,
  loadEnvelopeIntoStore,
  type LoadResult,
} from '$lib/graph/persistence';
import type { ydoc as Ydoc, patch as Patch } from '$lib/graph/store';
// Vite imports JSON natively as a parsed object.
import rawEnvelope from './media-burn.imp.json';

export const MEDIA_BURN_ENVELOPE_RAW: unknown = rawEnvelope;

let _validated: PatchEnvelope | null = null;
export function getMediaBurnEnvelope(): PatchEnvelope {
  if (_validated) return _validated;
  _validated = parseEnvelope(JSON.stringify(MEDIA_BURN_ENVELOPE_RAW));
  return _validated;
}

/**
 * Load the MEDIA BURN demo into the live store. Same contract as
 * `loadEnvelopeIntoStore` — clears whatever's currently in the rack +
 * replays the envelope's nodes (with per-module migrations applied).
 *
 * The 15 PICTUREBOX nodes carry their tile bytes inline; PictureboxCard
 * renders each tile on first mount. The CADILLAC node has no
 * `spawnedAtMs`, so the overlay treats load-time as spawn-time and the
 * 1s-to-first-hit timing is deterministic.
 */
export function loadMediaBurn(
  liveYdoc: typeof Ydoc,
  livePatch: typeof Patch,
): LoadResult {
  const envelope = getMediaBurnEnvelope();
  return loadEnvelopeIntoStore(envelope, liveYdoc, livePatch);
}
