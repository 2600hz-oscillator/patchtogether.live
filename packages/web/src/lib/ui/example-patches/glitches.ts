// packages/web/src/lib/ui/example-patches/glitches.ts
//
// "GLITCHES GET RICHES" — generative video+audio demo patch loaded by
// Canvas.svelte's `loadGlitches()` action (wired to the topbar button).
//
// Unlike the old hand-coded ATLANTIS demo (Object literals of nodes +
// wires), this patch ships as a serialized Yjs envelope captured from a
// live rackspace and re-loaded through the canonical persistence path
// (`loadEnvelopeIntoStore`). That gets us:
//   - automatic per-module migrations on load (envelope's moduleSchemas)
//   - identical code path to the user-facing Save/Load buttons
//   - the PICTUREBOX node already carries its `data.imageBytes` base64
//     payload in the envelope, so the bundled glitch.jpg renders on
//     mount with no extra wiring — PictureboxCard's $effect decodes
//     `node.data.imageBytes` whenever it changes.
//
// The bundled JPEG also lives at packages/web/static/example-assets/glitch.jpg
// for any future loader that needs a URL-loadable source (e.g. a
// `default_image_url` PICTUREBOX param). Not used by this loader.
//
// Envelope shape: { envelopeVersion: 1, savedAt, moduleSchemas, update }
// where `update` is a base64-encoded Yjs update blob containing `nodes`
// + `edges` Y.Maps.

import { type PatchEnvelope, parseEnvelope, loadEnvelopeIntoStore, type LoadResult } from '$lib/graph/persistence';
import type { ydoc as Ydoc, patch as Patch } from '$lib/graph/store';
// Vite imports JSON natively as a parsed object (typed as `any`).
import rawEnvelope from './glitches.imp.json';

/** The parsed envelope as imported by Vite. Re-validated via parseEnvelope
 *  before use so we get the same shape guarantees as a disk load. */
export const GLITCHES_ENVELOPE_RAW: unknown = rawEnvelope;

/** Lazily-validated singleton — parseEnvelope is non-trivial (JSON.stringify
 *  round-trip + shape checks) so memoize. */
let _validated: PatchEnvelope | null = null;
export function getGlitchesEnvelope(): PatchEnvelope {
  if (_validated) return _validated;
  // parseEnvelope expects a JSON string; we have the object already.
  _validated = parseEnvelope(JSON.stringify(GLITCHES_ENVELOPE_RAW));
  return _validated;
}

/**
 * Load the GLITCHES GET RICHES demo into the live store. Same contract
 * as `loadEnvelopeIntoStore` — clears the live store + replays the
 * envelope's nodes + edges (with per-module migrations applied).
 *
 * The PICTUREBOX node in this envelope already carries its image as
 * `data.imageBytes`, so PictureboxCard renders it on first mount.
 */
export function loadGlitches(
  liveYdoc: typeof Ydoc,
  livePatch: typeof Patch,
): LoadResult {
  const envelope = getGlitchesEnvelope();
  return loadEnvelopeIntoStore(envelope, liveYdoc, livePatch);
}
