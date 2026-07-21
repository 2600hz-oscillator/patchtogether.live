// packages/web/src/lib/ui/controls/vu-meter-model.ts
//
// PURE segment-lighting + color math for VuMeter.svelte. No DOM, no engine —
// so the "which segments light at level L" and "what color is segment i"
// decisions are unit-testable in isolation (the render component is a thin
// shell over these). Matches the moog914 "RESO" reference: a stack of short
// segments, lit bottom-up by level, warm (amber/yellow) at the top few → cool
// (teal/green) below, unlit segments dim.

export type VuOrientation = 'vertical' | 'horizontal';

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return v > 0 ? 1 : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The dBFS floor used by dbfsToUnit — signals at or below this read as 0. */
export const VU_DB_FLOOR = -60;

/**
 * Map a dBFS reading (−∞..0) to a 0..1 display fraction with a fixed floor.
 * 0 dBFS → 1, VU_DB_FLOOR (default −60) → 0, linear in dB between. Values above
 * 0 dBFS clamp to 1 (a clipping signal pins the meter). Non-finite → 0/1.
 */
export function dbfsToUnit(db: number, floor: number = VU_DB_FLOOR): number {
  if (!Number.isFinite(db)) return db > 0 ? 1 : 0;
  if (db >= 0) return 1;
  if (db <= floor) return 0;
  // db in (floor, 0): 0→1, floor→0.
  return 1 - db / floor;
}

/**
 * Is segment `index` (0 = bottom) lit at display level `level` (0..1) over a
 * bar of `segments` segments? A segment lights as soon as the level reaches the
 * BOTTOM of its band (index/segments), so level=0 lights none and level=1
 * lights all. Bottom-up.
 */
export function isSegmentLit(index: number, level: number, segments: number): boolean {
  if (segments <= 0 || index < 0 || index >= segments) return false;
  return clamp01(level) > index / segments;
}

/** How many segments are lit bottom-up at `level` (0..1). 0 at silence, `segments` at full. */
export function litCount(level: number, segments: number): number {
  if (segments <= 0) return 0;
  const l = clamp01(level);
  // Count segments whose band-bottom (i/segments) is below the level. This is
  // ceil(l*segments) for l in (0,1], guarded against float drift at the edges.
  let c = 0;
  for (let i = 0; i < segments; i++) if (l > i / segments) c++;
  return c;
}

// ---- Color zones -----------------------------------------------------------
//
// Fraction-from-bottom thresholds. The top WARM_HI band is amber (the "hot"
// / peak zone), the next WARM_LO band is yellow, everything below is a cool
// teal-green. Exposed so the component + tests share one source of truth.
export const VU_WARM_HI = 0.85; // ≥ this fraction → amber
export const VU_WARM_LO = 0.7; //  ≥ this fraction → yellow
export const VU_COLOR_AMBER = '#f5a524';
export const VU_COLOR_YELLOW = '#f5d024';
export const VU_COLOR_TEAL = '#2fd4a7';

/**
 * Color for segment `index` (0 = bottom) of a `segments`-tall bar. Warm at the
 * top (amber → yellow), cool teal-green below. Independent of the live level —
 * the level only decides lit vs. unlit; a lit segment always shows its zone
 * color, an unlit one is dimmed by the component.
 */
export function segmentColor(index: number, segments: number): string {
  const f = segments <= 1 ? 1 : index / (segments - 1);
  if (f >= VU_WARM_HI) return VU_COLOR_AMBER;
  if (f >= VU_WARM_LO) return VU_COLOR_YELLOW;
  return VU_COLOR_TEAL;
}
