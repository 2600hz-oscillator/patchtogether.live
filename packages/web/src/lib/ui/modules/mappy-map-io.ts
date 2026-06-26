// mappy-map-io.ts — PURE (de)serialize + validate for a MAPPY "map" file.
//
// A MAPPY *map* is the portable SURFACE LAYOUT for a venue's projector
// alignment: HOW MANY surfaces exist + each surface's GEOMETRY (its 4-corner
// quad in normalized [0,1] output space) + the per-surface FIT/CROP spatial
// mode. You align MAPPY to a physical projector target once, EXPORT the map,
// and IMPORT it into a DIFFERENT patch at the SAME venue to reuse that
// alignment. The map is deliberately PATCH-AGNOSTIC: it is NOT the input→
// surface routing, NOT the GRID override, NOT any runtime/engine state — just
// the spatial layout.
//
// This module is PURE on purpose (no `document` / `URL` / Blob): the card owns
// the thin browser glue (download / file-picker) and calls these; the unit test
// round-trips them directly. It lives under lib/ui (NOT lib/video/**) so it is
// OUTSIDE the WebGL/collab attest hash basis — see scripts/webgl-attest-lib.ts.
//
// All geometry coercion REUSES the canonical mappy pure helpers
// (normalizeSurfaces / surfaceFitOn / clampSurfaceCount) so the map's notion of
// a valid surface is identical to the engine's + the card's.

import {
  MAPPY_SURFACE_COUNT,
  normalizeSurfaces,
  surfaceFitOn,
  clampSurfaceCount,
  type MappySurfaceState,
} from '$lib/video/modules/mappy';
import type { Vec2 } from '$lib/video/mappy-homography';

/** The on-disk kind/version tag — a foreign or future file is REJECTED so a
 *  stray JSON (or a patch file, an audio preset, …) can never be applied. */
export const MAPPY_MAP_KIND = 'mappy-map' as const;
export const MAPPY_MAP_VERSION = 1 as const;

/** One surface's PORTABLE spatial state in the map file: its quad's four
 *  corners (TL, TR, BR, BL in normalized [0,1] output space) + its FIT mode
 *  (true = zoom-fit, false = crop/window). This is exactly the spatial subset
 *  of MappySurfaceState — no routing, no runtime. */
export interface MappyMapSurface {
  corners: [Vec2, Vec2, Vec2, Vec2];
  fit: boolean;
}

/** The serialized map: the venue's projector-alignment, reusable across patches.
 *  `count` is the number of LIVE surfaces; `surfaces` carries the geometry for
 *  ALL surface slots (so a +/− back up to a higher count restores the shape you
 *  had), mirroring how MAPPY persists its full 6-surface array. */
export interface MappyMap {
  version: typeof MAPPY_MAP_VERSION;
  kind: typeof MAPPY_MAP_KIND;
  count: number;
  surfaces: MappyMapSurface[];
}

/** The surface-layout PATCH applyMap returns — exactly the fields the import
 *  writes back into node.data (in place, via the mappy-edit seam). */
export interface MappyMapPatch {
  count: number;
  surfaces: MappySurfaceState[];
}

/** A copied-out plain surface (no live Y types) for the map file. */
function plainSurface(s: MappySurfaceState): MappyMapSurface {
  const c = s.corners;
  return {
    corners: [
      [c[0]![0], c[0]![1]],
      [c[1]![0], c[1]![1]],
      [c[2]![0], c[2]![1]],
      [c[3]![0], c[3]![1]],
    ],
    fit: surfaceFitOn(s),
  };
}

/**
 * Serialize the current MAPPY surface layout (read from node.data) into a
 * portable map object. Normalizes through the canonical helpers first so the
 * exported geometry is always the well-formed 6-surface array (every corner in
 * [0,1], FIT filled), and the LIVE count is clamped to [1,6].
 *
 * `data` is `node.data` (or any `{ surfaces?, surfaceCount? }`); reading from
 * the loose shape keeps this decoupled from the Y types.
 */
export function serializeMap(
  data: { surfaces?: unknown; surfaceCount?: unknown } | undefined,
): MappyMap {
  const surfaces = normalizeSurfaces(data?.surfaces);
  const count = clampSurfaceCount(data?.surfaceCount);
  return {
    version: MAPPY_MAP_VERSION,
    kind: MAPPY_MAP_KIND,
    count,
    surfaces: surfaces.map(plainSurface),
  };
}

/** Result of parsing untrusted JSON: either a valid map or a human-readable
 *  reason it was rejected (so the card can show a non-crashing message). */
export type ParseResult =
  | { ok: true; map: MappyMap }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse + VALIDATE untrusted JSON (a string or an already-parsed value) into a
 * MAPPY map. REJECTS (never throws) anything that is not a well-formed map:
 *   • non-JSON / non-object,
 *   • a foreign `kind` (not 'mappy-map') — so a patch/preset/garbage file can't
 *     be mistaken for a map,
 *   • a future/unknown `version`,
 *   • a missing/empty/non-array `surfaces`.
 * On success the geometry is run through the canonical normalizers, so even a
 * partly-malformed (but kind/version-correct) map loads as a clean layout.
 */
export function parseMap(input: unknown): ParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return { ok: false, error: 'empty file' };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
  }
  if (!isObject(raw)) {
    return { ok: false, error: 'not a MAPPY map (expected a JSON object)' };
  }
  if (raw.kind !== MAPPY_MAP_KIND) {
    return {
      ok: false,
      error: `not a MAPPY map (kind="${String(raw.kind)}", expected "${MAPPY_MAP_KIND}")`,
    };
  }
  if (raw.version !== MAPPY_MAP_VERSION) {
    return {
      ok: false,
      error: `unsupported map version (${String(raw.version)}); this build reads v${MAPPY_MAP_VERSION}`,
    };
  }
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    return { ok: false, error: 'map has no surfaces' };
  }

  // Geometry is canonicalized below; `count` defaults to the number of surfaces
  // in the file when absent/garbage (a map's surfaces ARE its live layout).
  const normalized = normalizeSurfaces(raw.surfaces);
  const fits = (raw.surfaces as unknown[]).map((s) => surfaceFitOn(s as { fit?: unknown }));
  const surfaces: MappyMapSurface[] = normalized.map((s, i) => ({
    corners: s.corners,
    fit: fits[i] ?? true,
  }));
  const fileCount = (raw.surfaces as unknown[]).length;
  const count = clampSurfaceCount(raw.count ?? fileCount);

  return {
    ok: true,
    map: { version: MAPPY_MAP_VERSION, kind: MAPPY_MAP_KIND, count, surfaces },
  };
}

/**
 * Turn a validated map into the surface-layout PATCH to write into node.data.
 * Produces the canonical full 6-surface array (so a slot beyond `count` still
 * has well-formed geometry to restore on a later +) and the clamped live count.
 * Pure — the caller applies this via the in-place Yjs mutation seam.
 */
export function applyMap(map: MappyMap): MappyMapPatch {
  // Re-normalize through the canonical helper so the written array is ALWAYS a
  // full MAPPY_SURFACE_COUNT array with the map's FIT modes preserved.
  const base = normalizeSurfaces(map.surfaces);
  const surfaces: MappySurfaceState[] = base.map((s, i) => ({
    corners: s.corners,
    fit: map.surfaces[i] ? map.surfaces[i]!.fit : surfaceFitOn(s),
  }));
  return {
    count: clampSurfaceCount(map.count),
    surfaces: surfaces.slice(0, MAPPY_SURFACE_COUNT),
  };
}
