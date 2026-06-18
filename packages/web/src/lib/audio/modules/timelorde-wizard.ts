// packages/web/src/lib/audio/modules/timelorde-wizard.ts
//
// Pure, unit-tested helpers for TIMELORDE's beat-pulsing card art (the owner's
// folk-art OWL PAINTING). Everything that has real logic lives here so
// TimelordeCard.svelte stays a thin renderer:
//
//   1. beatPulse()            — the brightness a beat-synced pulse should have
//      RIGHT NOW (flash on the beat, decay before the next).
//   2. boostBeatColor()       — a COLOUR-TARGETED brightness boost: brighten a
//      pixel ONLY if its colour is near the owl's YELLOW EYES or BLUE BORDER,
//      scaled by the current pulse. The brown/tan owl body is left untouched,
//      so only the eyes + border visibly pulse with the beat.
//   3. gateLevelToWizardOn()  — interpret the `gate` INPUT level as the on/off
//      state (level-sensitive — see gate semantics below).
//
// None of these touch the DOM / AudioContext / Svelte, so they run in vitest
// with no browser. See timelorde-wizard.test.ts.
//
// The owl image itself is a bundled static asset (packages/web/static/img/
// timelorde-owl.png — the owner's own painting) drawn by the card; nothing
// here references the pixels — these are the pure maths the renderer drives.

import { GATE_HI } from '$lib/audio/gate-trigger';

// ─────────────────────────────────────────────────────────────────────────
// 1. Beat-pulse math
// ─────────────────────────────────────────────────────────────────────────

export interface BeatPulseArgs {
  /** Master tempo in BPM (the SAME value TIMELORDE's worklet uses — when an
   *  external clock is locked the card reads the measured BPM into this). */
  bpm: number;
  /** Transport state: false = STOPPED (owl idle/dim, no pulse). */
  running: boolean;
  /** Wall-clock "now" in ms (performance.now() at the render frame). */
  nowMs: number;
  /** Wall-clock ms captured when the transport last STARTED — the beat
   *  phase is measured from here so the flash lands on the downbeat after a
   *  start, instead of at an arbitrary offset. */
  anchorMs: number;
  /** Fraction of one beat the flash takes to decay back to idle (0..1).
   *  0.6 = bright on the beat, faded by 60% of the way to the next beat. */
  decayFraction?: number;
}

/**
 * The pulse intensity (0 = idle/dim … 1 = full flash) the art should show
 * RIGHT NOW. The eyes + border flash to 1 exactly on each beat and decay
 * toward 0 before the next beat.
 *
 * Phase is derived from the SAME `bpm` the clock runs at + a start anchor — it
 * does NOT spin up a second clock (no setInterval / no audio tap). It's a
 * cheap deterministic function of (bpm, now − anchor). When `running` is false
 * (or bpm is non-positive) it returns 0 so the art sits idle while stopped.
 *
 * Shape: a linear decay across `decayFraction` of the beat. At phase 0 → 1; at
 * phase ≥ decayFraction → 0; linear in between. Linear (not exponential) keeps
 * the math trivially testable and the visual "snappy".
 */
export function beatPulse(args: BeatPulseArgs): number {
  const { bpm, running, nowMs, anchorMs } = args;
  const decayFraction = clamp01(args.decayFraction ?? 0.6);
  if (!running) return 0;
  if (!(bpm > 0)) return 0;
  if (decayFraction <= 0) return 0;

  const beatMs = 60_000 / bpm; // ms per quarter-note beat
  const elapsed = nowMs - anchorMs;
  // Phase within the current beat, 0..1. Math.floor handles negative elapsed
  // (now before anchor) by wrapping into [0,1) just like a positive value.
  const beats = elapsed / beatMs;
  const phase = beats - Math.floor(beats);

  if (phase >= decayFraction) return 0;
  // 1 at phase 0, linearly to 0 at phase === decayFraction.
  return 1 - phase / decayFraction;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Colour-targeted beat boost (the EYES + BORDER pulse, the body doesn't)
// ─────────────────────────────────────────────────────────────────────────
//
// The faithful "only the yellow eyes + the blue border light up" effect is a
// per-pixel colour key on the drawn ImageData: for each pixel decide how much
// it belongs to the YELLOW band (the eyes) or the BLUE band (the border) and
// brighten it by `pulse · amount · membership`, leaving every other pixel
// (the brown/tan owl body, the dark ground) byte-identical.
//
// We classify in HSV because hue cleanly separates the owl's palette:
//   • the brown/tan BODY sits at hue ~20–40°   (NOT boosted)
//   • the YELLOW EYES sit at hue ~45–85°       (boosted)
//   • the BLUE BORDER sits at hue ~200–235°    (boosted)
// (measured from the owner's painting). Membership ramps smoothly to the band
// edges so there's no hard aliasing seam between body and eyes. Saturation +
// value floors drop the near-grey/near-black pixels (they have an unstable hue)
// so the dark ground never flickers.

/** Hue band (inclusive degrees) + a soft feather either side, plus sat/val
 *  floors below which a pixel is considered colourless (no boost). */
interface ColorBand {
  hueLo: number;
  hueHi: number;
  /** Soft feather (degrees) ramped on each side of [hueLo, hueHi]. */
  feather: number;
  /** Minimum saturation (0..1) to count as this colour. */
  satMin: number;
  /** Minimum value/brightness (0..1) to count as this colour. */
  valMin: number;
}

/** The owl's YELLOW EYES band. Floor is above the brown body's hue (~20–40°)
 *  so the tan plumage is excluded; the feather still tapers smoothly. */
export const YELLOW_BAND: ColorBand = {
  hueLo: 45,
  hueHi: 85,
  feather: 8,
  satMin: 0.32,
  valMin: 0.42,
};

/** The owl's painted BLUE BORDER band. */
export const BLUE_BAND: ColorBand = {
  hueLo: 200,
  hueHi: 238,
  feather: 10,
  satMin: 0.28,
  valMin: 0.18,
};

/** Default boost strength (added brightness fraction at full pulse + full
 *  membership). 0.6 = up to +60% toward white on the brightest beat. */
export const DEFAULT_BOOST_AMOUNT = 0.6;

/** RGB (0..255) → HSV with h in [0,360), s,v in [0,1]. Pure. */
export function rgbToHsv(r: number, g: number, b: number): {
  h: number;
  s: number;
  v: number;
} {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** Membership (0..1) of a pixel in one colour band: 1 fully inside the hue
 *  window, ramping to 0 across the feather, and 0 if it's too grey/dark. Pure. */
export function colorBandMembership(
  r: number,
  g: number,
  b: number,
  band: ColorBand,
): number {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (s < band.satMin || v < band.valMin) return 0;
  if (h >= band.hueLo && h <= band.hueHi) return 1;
  // Feather below the low edge / above the high edge.
  if (h < band.hueLo) {
    const d = band.hueLo - h;
    return d < band.feather ? 1 - d / band.feather : 0;
  }
  const d = h - band.hueHi;
  return d < band.feather ? 1 - d / band.feather : 0;
}

/**
 * Boost ONE pixel's colour for the beat pulse. Returns the new [r,g,b]
 * (0..255, rounded). A pixel near the eyes (YELLOW_BAND) or the border
 * (BLUE_BAND) is brightened toward white by `pulse · amount · membership`;
 * any other pixel is returned UNCHANGED. Pure — unit-tested.
 *
 * @param pulse  0..1 beat-pulse intensity (from beatPulse()).
 * @param amount peak added-brightness fraction (defaults to DEFAULT_BOOST_AMOUNT).
 */
export function boostBeatColor(
  r: number,
  g: number,
  b: number,
  pulse: number,
  amount: number = DEFAULT_BOOST_AMOUNT,
): [number, number, number] {
  const p = clamp01(pulse);
  if (p <= 0 || amount <= 0) return [r, g, b];
  // A pixel can only belong to one of the two well-separated bands; take the
  // stronger membership so a feather overlap can't double-count.
  const membership = Math.max(
    colorBandMembership(r, g, b, YELLOW_BAND),
    colorBandMembership(r, g, b, BLUE_BAND),
  );
  if (membership <= 0) return [r, g, b];
  // Lerp toward white by k. k≤1, so a fully-lit beat at full membership lifts
  // the pixel `amount` of the way to white (a glow), never overshooting.
  const k = clamp01(p * amount * membership);
  return [
    Math.round(r + (255 - r) * k),
    Math.round(g + (255 - g) * k),
    Math.round(b + (255 - b) * k),
  ];
}

/**
 * Apply boostBeatColor to a whole RGBA pixel buffer IN PLACE (the eyes +
 * border get brighter, everything else stays). Pure w.r.t. the DOM — the card
 * passes the display's ImageData.data; vitest passes a plain Uint8ClampedArray.
 * The alpha channel is untouched. Returns the same buffer for chaining.
 */
export function applyBeatBoost(
  data: Uint8ClampedArray,
  pulse: number,
  amount: number = DEFAULT_BOOST_AMOUNT,
): Uint8ClampedArray {
  const p = clamp01(pulse);
  if (p <= 0 || amount <= 0) return data; // idle frame: leave the owl as-is
  for (let i = 0; i < data.length; i += 4) {
    const [nr, ng, nb] = boostBeatColor(
      data[i] ?? 0,
      data[i + 1] ?? 0,
      data[i + 2] ?? 0,
      p,
      amount,
    );
    data[i] = nr;
    data[i + 1] = ng;
    data[i + 2] = nb;
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Gate → on/off interpretation
// ─────────────────────────────────────────────────────────────────────────
//
// GATE SEMANTICS (chosen — documented so the owner can correct it):
//
//   The `gate` INPUT is LEVEL-SENSITIVE (declared `edge: 'gate'`):
//     • gate HIGH (level ≥ GATE_HI)  → owl ON  (shown + pulsing)
//     • gate LOW  (level <  GATE_HI) → owl OFF (hidden)
//
//   It is NOT edge-triggered: holding the gate high keeps the owl on; it does
//   not toggle on each rising edge. This matches the owner's phrasing "that
//   button is on a gate" — an external gate can SHOW/HIDE the owl exactly like
//   the on-card button, and the two converge on one on/off state (the button
//   is a manual override; the gate is external control). When no gate cable is
//   patched, only the button governs.
//
//   To FLIP the meaning (gate HIGH = off), the owner inverts the comparison
//   here in one place.

/** Interpret a gate INPUT level (0..1 CV) as the owl on/off state.
 *  HIGH (≥ GATE_HI) = on (true); LOW = off (false). Level-sensitive. */
export function gateLevelToWizardOn(level: number): boolean {
  return level >= GATE_HI;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Big display: OWL vs LIVE VIDEO
// ─────────────────────────────────────────────────────────────────────────
//
// TIMELORDE's big square display normally shows the beat-pulsing owl. With
// something patched into the `video_in` jack it shows that LIVE VIDEO FEED
// instead (and `video_out` passes the feed through — in → display → out). The
// pure decision of WHICH to show lives here so the card stays a thin renderer
// and the rule is unit-tested.

/** What the big display should render right now. */
export type WizardDisplayMode = 'video' | 'wizard' | 'off';

/**
 * Decide the big-display mode from the two inputs:
 *   - `hasVideoIn`  — is a cable patched into the `video_in` jack?
 *   - `wizardOn`    — the show/hide flag (button + gate input).
 *
 * Rules (in priority order):
 *   1. A patched video feed ALWAYS wins — the operator wired TIMELORDE inline
 *      in a video chain, so the display IS the monitor (independent of the owl
 *      toggle — the toggle only ever governed the owl art).
 *   2. Otherwise, show the owl when `wizardOn`, else the "off" placeholder.
 *
 * This keeps the existing owl↔off behaviour byte-identical when no video is
 * patched, and makes the feed take over the moment a cable lands.
 */
export function wizardDisplayMode(args: {
  hasVideoIn: boolean;
  wizardOn: boolean;
}): WizardDisplayMode {
  if (args.hasVideoIn) return 'video';
  return args.wizardOn ? 'wizard' : 'off';
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
