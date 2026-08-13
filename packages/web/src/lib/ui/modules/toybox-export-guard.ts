// packages/web/src/lib/ui/modules/toybox-export-guard.ts
//
// EXPORT MUST NOT SUCCEED AT PRODUCING NOTHING — the pure decision behind
// TOYBOX's `.toybox.zip` export refusing to write a preset it knows is
// incomplete (#1589).
//
// THE BUG THIS EXISTS FOR: `resolveLayerVideos` walks the layers and SKIPS any
// layer with no live object url. That is the right behaviour for a layer that
// genuinely has no local file (a patched inA/inB feed, a webcam, an empty
// layer) — and it was silently also the behaviour for a layer whose bytes had
// been DESTROYED by a card unmount. So after a collapse, Export wrote a zip
// with ZERO video entries, reported `Exported X.toybox.zip`, and the user found
// out weeks later when the preset opened black. The lifetime fix stops the
// bytes from dying; this guard makes the failure LOUD if they ever do again,
// and it is correct independently of that fix.
//
// THE ASYMMETRY THAT MAKES THIS WORTH A MODULE: the Y.Doc knows a video layer's
// FILENAME (it syncs), and the local session knows its BYTES (they do not).
// Those two facts can disagree, and every way they disagree is invisible from
// either side alone:
//   * name + bytes  → export it (the normal case);
//   * name, NO bytes → the preset would be a lie. This is a page reload, a
//     preset loaded from localStorage (which cannot hold video), a rack-mate's
//     synced layer, or the #1589 teardown. REFUSE.
//   * no name       → the user never picked a file for this layer. Nothing is
//     missing; exporting is correct.
//   * source ≠ file → a patched feed or the webcam. There are no bytes to
//     embed BY DESIGN, so it can never make the export incomplete.
//
// PURE + DOM-free + registry-free, so it unit-tests with no browser, no engine
// and no Y.Doc. It also lives OUTSIDE `lib/video/**`, which is hashed WHOLESALE
// for the WebGL attest — putting this decision next to `toybox-preset-io.ts`
// would have cost a GPU re-attest window for a rule that cannot move a pixel.

/** A layer the exported preset is EXPECTED to carry bytes for. */
export interface ExpectedLayerVideo {
  /** 0-indexed layer, as stored. */
  layer: number;
  /** The filename that rides the Y.Doc — what the card is showing the user. */
  name: string;
}

/** The one place the two filename spellings are reconciled. `videoMeta.name` is
 *  what `setLayerVideoName` writes today; `videoName` is the flat key older
 *  preset blobs (and the import path's manifests) carry. A layer that has
 *  either has had a file picked for it. */
export function layerVideoName(layer: Record<string, unknown> | undefined): string | null {
  if (!layer || typeof layer !== 'object') return null;
  const meta = layer.videoMeta as { name?: unknown } | undefined;
  const fromMeta = meta && typeof meta === 'object' ? meta.name : undefined;
  const raw = typeof fromMeta === 'string' ? fromMeta : layer.videoName;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Which layers of a data blob a complete export MUST contain bytes for.
 *
 * DERIVED from the blob, never a count and never a list: a fifth layer, a new
 * video source or a renamed field changes the answer without changing this
 * code's shape. An unparseable / absent `layers` yields `[]` — with nothing
 * declared there is nothing to be missing, and a guard that fired on garbage
 * would block exports it knows nothing about.
 */
export function expectedVideoLayers(layers: unknown): ExpectedLayerVideo[] {
  if (!Array.isArray(layers)) return [];
  const out: ExpectedLayerVideo[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i] as Record<string, unknown> | undefined;
    if (!layer || typeof layer !== 'object') continue;
    if (layer.kind !== 'video') continue;
    // Absent source === 'file' (the #603 default), so an older blob that
    // predates the selector is still judged as the local-file player it is.
    const source = typeof layer.videoSource === 'string' ? layer.videoSource : 'file';
    if (source !== 'file') continue;
    const name = layerVideoName(layer);
    if (!name) continue;
    out.push({ layer: i, name });
  }
  return out;
}

/**
 * The expected layers that the resolver could NOT produce bytes for.
 *
 * `resolved` is the layer indices that actually carry NON-EMPTY bytes — a
 * zero-length entry is counted as missing on purpose, because a 0-byte video in
 * the zip is the same lie as no video at all.
 */
export function missingVideoLayers(
  expected: readonly ExpectedLayerVideo[],
  resolved: Iterable<number>,
): ExpectedLayerVideo[] {
  const have = new Set(resolved);
  return expected.filter((e) => !have.has(e.layer));
}

/**
 * The user-facing refusal, or null when the export is complete and may proceed.
 *
 * Names the LAYER (1-indexed, matching the card's tab labels) and the FILE the
 * card is showing, because "export failed" without those two is not actionable
 * — the whole point is that the user can see which layer to re-pick.
 */
export function exportRefusalMessage(missing: readonly ExpectedLayerVideo[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.map((m) => `layer ${m.layer + 1} ("${m.name}")`).join(', ');
  const plural = missing.length === 1 ? 'its video is' : 'their videos are';
  return (
    `Export cancelled — ${plural} not loaded in this session: ${list}. ` +
    `Re-pick the file(s) on those layers, or set them to a patched feed, then export again. ` +
    `(Writing the preset now would produce a zip with no video for them.)`
  );
}
