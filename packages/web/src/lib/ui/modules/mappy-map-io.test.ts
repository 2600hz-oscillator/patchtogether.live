// mappy-map-io.test.ts — PURE round-trip + validation tests for the MAPPY map
// (de)serializer. No DOM, no Y.Doc — just the pure helpers, so it round-trips
// the portable surface LAYOUT (count + per-surface corners + FIT) and rejects
// foreign/garbage input. Lives under lib/ui (OUTSIDE the WebGL attest basis).

import { describe, it, expect } from 'vitest';
import {
  serializeMap,
  parseMap,
  applyMap,
  MAPPY_MAP_KIND,
  MAPPY_MAP_VERSION,
} from './mappy-map-io';
import { normalizeSurfaces, MAPPY_SURFACE_COUNT } from '$lib/video/modules/mappy';

/** Build a node.data with ≥2 surfaces at DISTINCT positions + mixed FIT, plus a
 *  live surfaceCount. The remaining slots stay full-frame (normalizeSurfaces
 *  fills them). */
function makeData() {
  const surfaces = normalizeSurfaces([
    // surface 0 — a top-left box, CROP
    { corners: [[0.05, 0.95], [0.45, 0.92], [0.43, 0.55], [0.07, 0.58]], fit: false },
    // surface 1 — a bottom-right skew, FIT (default)
    { corners: [[0.55, 0.4], [0.95, 0.42], [0.92, 0.05], [0.58, 0.08]], fit: true },
    // surface 2 — a centred diamond-ish quad, CROP
    { corners: [[0.5, 0.8], [0.8, 0.5], [0.5, 0.2], [0.2, 0.5]], fit: false },
  ]);
  return { surfaces, surfaceCount: 3 };
}

describe('mappy-map-io — serialize/apply round-trip', () => {
  it('round-trips the surface layout: serialize → parse → applyMap deep-equals the original', () => {
    const data = makeData();

    const map = serializeMap(data);
    // the payload is the venue layout, not the patch
    expect(map.kind).toBe(MAPPY_MAP_KIND);
    expect(map.version).toBe(MAPPY_MAP_VERSION);
    expect(map.count).toBe(3);
    expect(map.surfaces).toHaveLength(MAPPY_SURFACE_COUNT);

    // through a real JSON string (what the file actually carries)
    const json = JSON.stringify(map);
    const parsed = parseMap(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const applied = applyMap(parsed.map);

    // the live count survives
    expect(applied.count).toBe(data.surfaceCount);
    // EVERY surface's geometry + FIT survives the full round-trip
    expect(applied.surfaces).toEqual(data.surfaces);
  });

  it('preserves DISTINCT corner positions for each surface (not collapsed/shared)', () => {
    const data = makeData();
    const applied = applyMap(serializeMap(data));
    expect(applied.surfaces[0]!.corners).not.toEqual(applied.surfaces[1]!.corners);
    expect(applied.surfaces[0]!.corners).toEqual(data.surfaces[0]!.corners);
    expect(applied.surfaces[1]!.corners).toEqual(data.surfaces[1]!.corners);
  });

  it('preserves per-surface FIT/CROP across the round-trip', () => {
    const data = makeData();
    const applied = applyMap(serializeMap(data));
    expect(applied.surfaces[0]!.fit).toBe(false); // CROP
    expect(applied.surfaces[1]!.fit).toBe(true); // FIT
    expect(applied.surfaces[2]!.fit).toBe(false); // CROP
  });

  it('serializes a full 6-surface array even when fewer are live', () => {
    const map = serializeMap({ surfaces: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], fit: true }], surfaceCount: 1 });
    expect(map.count).toBe(1);
    expect(map.surfaces).toHaveLength(MAPPY_SURFACE_COUNT);
  });

  it('clamps an out-of-range live count on apply', () => {
    const map = serializeMap(makeData());
    const applied = applyMap({ ...map, count: 99 });
    expect(applied.count).toBe(MAPPY_SURFACE_COUNT);
    const lo = applyMap({ ...map, count: 0 });
    expect(lo.count).toBe(1);
  });
});

describe('mappy-map-io — validation rejects foreign/garbage input', () => {
  it('rejects empty input', () => {
    expect(parseMap('').ok).toBe(false);
    expect(parseMap('   ').ok).toBe(false);
  });

  it('rejects non-JSON', () => {
    const r = parseMap('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/i);
  });

  it('rejects a JSON value that is not an object (array / number / null)', () => {
    expect(parseMap('[]').ok).toBe(false);
    expect(parseMap('42').ok).toBe(false);
    expect(parseMap('null').ok).toBe(false);
  });

  it('rejects a foreign kind (a patch / preset / unrelated file)', () => {
    const foreign = JSON.stringify({ kind: 'patch', version: 1, nodes: [], surfaces: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }] });
    const r = parseMap(foreign);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/MAPPY map/i);
  });

  it('rejects an unsupported version', () => {
    const future = JSON.stringify({ kind: MAPPY_MAP_KIND, version: 999, surfaces: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], fit: true }] });
    const r = parseMap(future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/i);
  });

  it('rejects a map with no surfaces', () => {
    const empty = JSON.stringify({ kind: MAPPY_MAP_KIND, version: MAPPY_MAP_VERSION, surfaces: [] });
    expect(parseMap(empty).ok).toBe(false);
    const missing = JSON.stringify({ kind: MAPPY_MAP_KIND, version: MAPPY_MAP_VERSION });
    expect(parseMap(missing).ok).toBe(false);
  });

  it('a rejected parse leaves the caller free to NOT mutate (returns ok:false, no throw)', () => {
    // The whole point: a foreign file is a clean rejection, never an exception.
    expect(() => parseMap('garbage')).not.toThrow();
    expect(() => parseMap({ kind: 'nope' })).not.toThrow();
    expect(parseMap({ kind: 'nope' }).ok).toBe(false);
  });

  it('accepts + canonicalizes a partly-malformed but kind/version-correct map', () => {
    // out-of-range corners + a too-short corner list → normalized to a clean
    // layout (the import is forgiving once the kind/version match).
    const dirty = JSON.stringify({
      kind: MAPPY_MAP_KIND,
      version: MAPPY_MAP_VERSION,
      count: 2,
      surfaces: [
        { corners: [[2, -1], [1, 0], [1, 1], [0, 1]], fit: false }, // corner out of [0,1]
        { corners: [[0, 0], [1, 0]] }, // too short → full-frame default
      ],
    });
    const r = parseMap(dirty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const applied = applyMap(r.map);
    expect(applied.count).toBe(2);
    // every corner clamped into [0,1]
    for (const s of applied.surfaces) {
      for (const c of s.corners) {
        expect(c[0]).toBeGreaterThanOrEqual(0);
        expect(c[0]).toBeLessThanOrEqual(1);
        expect(c[1]).toBeGreaterThanOrEqual(0);
        expect(c[1]).toBeLessThanOrEqual(1);
      }
    }
  });
});
