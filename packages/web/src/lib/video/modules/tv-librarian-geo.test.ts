// packages/web/src/lib/video/modules/tv-librarian-geo.test.ts
//
// Pure geometry tests for the 2D world-map country picker. Verifies the
// equirectangular projection + the click → nearest-available-country
// resolution (the load-bearing map interaction).

import { describe, expect, it } from 'vitest';
import {
  latLonToUV,
  uvToLatLon,
  nearestCountry,
  countryMarkers,
  COUNTRY_CENTROIDS,
} from './tv-librarian-geo';

describe('equirectangular projection', () => {
  it('maps lat/lon to UV in [0,1], north-up', () => {
    expect(latLonToUV(0, 0)).toEqual({ x: 0.5, y: 0.5 });          // equator/prime meridian = center
    expect(latLonToUV(90, -180)).toEqual({ x: 0, y: 0 });          // north pole / antimeridian = top-left
    expect(latLonToUV(-90, 180)).toEqual({ x: 1, y: 1 });          // south pole / +180 = bottom-right
  });
  it('round-trips UV → latlon → UV', () => {
    const { lat, lon } = uvToLatLon(0.75, 0.25);
    const back = latLonToUV(lat, lon);
    expect(back.x).toBeCloseTo(0.75, 6);
    expect(back.y).toBeCloseTo(0.25, 6);
  });
});

describe('nearestCountry', () => {
  const all = new Set(Object.keys(COUNTRY_CENTROIDS));

  it('resolves a click over the continental US to US', () => {
    const { x, y } = latLonToUV(39, -98); // central US
    expect(nearestCountry(x, y, all)).toBe('US');
  });

  it('resolves a click over western Europe to a European country, not the US', () => {
    const { x, y } = latLonToUV(48, 2); // ~Paris
    const code = nearestCountry(x, y, all);
    expect(code).toBe('FR');
  });

  it('only considers AVAILABLE countries (dataset-with-channels)', () => {
    // Click on the US centroid, but US not in the available set → nearest
    // available falls to a neighbor (CA/MX), never US.
    const { x, y } = latLonToUV(39, -98);
    const available = new Set(['CA', 'MX', 'BR']);
    const code = nearestCountry(x, y, available);
    expect(code).not.toBe('US');
    expect(['CA', 'MX']).toContain(code);
  });

  it('rejects an open-ocean click far from any country (maxDeg guard)', () => {
    const { x, y } = latLonToUV(-40, -140); // South Pacific, nothing near
    expect(nearestCountry(x, y, all, 20)).toBeNull();
  });

  it('returns null when no available country has a centroid', () => {
    const { x, y } = latLonToUV(0, 0);
    expect(nearestCountry(x, y, new Set(['ZZ']))).toBeNull();
  });
});

describe('countryMarkers', () => {
  it('emits a UV marker only for available countries with a centroid', () => {
    const markers = countryMarkers(new Set(['US', 'FR', 'ZZ']));
    const codes = markers.map((m) => m.code).sort();
    expect(codes).toEqual(['FR', 'US']); // ZZ has no centroid
    for (const m of markers) {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(1);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(1);
    }
  });
});
