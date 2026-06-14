// packages/web/src/lib/video/modules/tv-librarian-geo.ts
//
// PURE geometry for the 2D world-map country picker (v1 — NO three.js; the
// repo is raw-WebGL2 and we do not add a 3D globe / three-globe dep). The map
// is a simple EQUIRECTANGULAR projection: longitude → x in [0,1], latitude →
// y in [0,1] (north-up). We embed a compact country-CENTROID table (ISO-2 →
// [lat, lon]); clicking the map resolves to the NEAREST centroid among the
// countries that actually have channels. This keeps the picker dependency-free
// and VRT-friendly while preserving the famelack "click a place → channels"
// flow. A textual country list is the always-available fallback.
//
// Centroids are approximate geographic centers (degrees). Source: public-domain
// country centroid data (Google dataset / Natural Earth-derived), trimmed to a
// representative set covering the dataset's top countries + every continent.
// Countries absent from this table simply aren't clickable on the map (they
// remain selectable from the list), so a missing centroid degrades gracefully.

/** lat (−90..90), lon (−180..180) for a country's approximate center. */
export type LatLon = readonly [number, number];

/** ISO-3166 alpha-2 (UPPERCASE) → centroid. Compact, hand-trimmed table. */
export const COUNTRY_CENTROIDS: Readonly<Record<string, LatLon>> = {
  US: [39.78, -100.45], CA: [62.39, -96.82], MX: [23.95, -102.52],
  BR: [-10.79, -53.09], AR: [-35.38, -65.18], CL: [-37.73, -71.38],
  CO: [3.91, -73.08], PE: [-9.15, -74.38], VE: [7.12, -66.18],
  GB: [54.12, -2.86], IE: [53.18, -8.14], FR: [46.56, 2.46],
  ES: [40.0, -3.65], PT: [39.6, -8.0], DE: [51.11, 10.38],
  IT: [42.5, 12.07], NL: [52.1, 5.28], BE: [50.64, 4.64],
  CH: [46.8, 8.23], AT: [47.59, 14.14], PL: [52.13, 19.39],
  CZ: [49.74, 15.34], SK: [48.7, 19.49], HU: [47.16, 19.4],
  RO: [45.85, 24.97], BG: [42.77, 25.23], GR: [39.07, 22.96],
  RS: [44.22, 20.79], HR: [45.08, 16.41], SI: [46.15, 14.99],
  UA: [48.99, 31.39], BY: [53.53, 28.03], RU: [61.98, 96.69],
  SE: [62.78, 16.75], NO: [68.75, 15.35], FI: [64.5, 26.27],
  DK: [55.97, 10.03], IS: [64.99, -18.57], EE: [58.67, 25.54],
  LV: [56.85, 24.92], LT: [55.34, 23.88], MK: [41.6, 21.69],
  AL: [41.14, 20.07], AD: [42.55, 1.6],
  TR: [38.96, 35.24], IL: [31.46, 35.0], PS: [31.92, 35.2],
  SA: [24.12, 44.54], AE: [23.91, 54.3], QA: [25.32, 51.18],
  IR: [32.57, 54.3], IQ: [33.04, 43.74], SY: [35.03, 38.51],
  LB: [33.92, 35.88], JO: [31.25, 37.25], KW: [29.34, 47.59],
  IN: [22.89, 79.61], PK: [29.95, 69.34], BD: [23.87, 90.23],
  LK: [7.61, 80.7], NP: [28.25, 83.94], AF: [33.84, 66.03],
  CN: [36.56, 103.82], JP: [37.59, 138.03], KR: [36.39, 127.83],
  TW: [23.75, 120.95], HK: [22.4, 114.11], TH: [15.12, 101.0],
  VN: [16.66, 106.3], PH: [11.78, 122.88], ID: [-2.48, 117.84],
  MY: [3.79, 109.7], SG: [1.36, 103.82], MM: [21.18, 96.49],
  KH: [12.72, 104.91],
  EG: [26.49, 29.86], MA: [31.88, -6.91], DZ: [28.16, 2.63],
  TN: [34.12, 9.55], LY: [27.04, 18.0], NG: [9.59, 8.09],
  GH: [7.96, -1.21], KE: [0.6, 37.8], ET: [8.62, 39.61],
  ZA: [-29.0, 25.08], TZ: [-6.27, 34.81], UG: [1.28, 32.37],
  CD: [-2.88, 23.64], CM: [5.69, 12.74], SN: [14.36, -14.47],
  CI: [7.63, -5.56], TG: [8.52, 0.96], NA: [-22.13, 17.21],
  AU: [-25.73, 134.49], NZ: [-41.81, 171.48],
  GP: [16.19, -61.27], DO: [18.89, -70.51], GE: [42.17, 43.51],
};

/** Project lat/lon to map UV (x,y in [0,1]); equirectangular, north-up. */
export function latLonToUV(lat: number, lon: number): { x: number; y: number } {
  const x = (lon + 180) / 360;
  const y = (90 - lat) / 180;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Inverse: map UV → lat/lon. */
export function uvToLatLon(x: number, y: number): { lat: number; lon: number } {
  return { lon: x * 360 - 180, lat: 90 - y * 180 };
}

/** Squared great-circle-ish distance in plain degrees (good enough for nearest-
 *  centroid hit-testing on a flat map; wraps longitude at the antimeridian). */
function degDist2(aLat: number, aLon: number, bLat: number, bLon: number): number {
  let dLon = Math.abs(aLon - bLon);
  if (dLon > 180) dLon = 360 - dLon;
  const dLat = aLat - bLat;
  // Scale longitude by cos(lat) so high-latitude clicks aren't over-weighted.
  const latMid = ((aLat + bLat) / 2) * (Math.PI / 180);
  const lonScaled = dLon * Math.cos(latMid);
  return dLat * dLat + lonScaled * lonScaled;
}

/**
 * Resolve a click at map UV (x,y) to the NEAREST country code AMONG `available`
 * (the set with channels). Only considers countries present in the centroid
 * table. Returns null if none of the available countries are mappable. A
 * `maxDeg` guard rejects clicks far from any country (open ocean) so a stray
 * click doesn't snap to a distant landmass.
 */
export function nearestCountry(
  x: number,
  y: number,
  available: ReadonlySet<string>,
  maxDeg = 35,
): string | null {
  const { lat, lon } = uvToLatLon(x, y);
  let best: string | null = null;
  let bestD = Infinity;
  for (const [code, c] of Object.entries(COUNTRY_CENTROIDS)) {
    if (!available.has(code)) continue;
    const d = degDist2(lat, lon, c[0], c[1]);
    if (d < bestD) { bestD = d; best = code; }
  }
  if (best === null) return null;
  if (bestD > maxDeg * maxDeg) return null;
  return best;
}

/** Map-UV positions for every available country that has a centroid — the
 *  dots the card draws as clickable markers. */
export function countryMarkers(
  available: ReadonlySet<string>,
): Array<{ code: string; x: number; y: number }> {
  const out: Array<{ code: string; x: number; y: number }> = [];
  for (const [code, c] of Object.entries(COUNTRY_CENTROIDS)) {
    if (!available.has(code)) continue;
    const { x, y } = latLonToUV(c[0], c[1]);
    out.push({ code, x, y });
  }
  return out;
}
