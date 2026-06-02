// packages/dsp/src/lib/sample-hold-dsp.ts
//
// SAMPLE & HOLD / quantizer — the PURE DSP core, shared verbatim by:
//   * the AudioWorklet (packages/dsp/src/sample-hold.ts) — the live latch +
//     quantizer hot path, and
//   * unit + ART tests (no AudioContext, deterministic) — the same math.
//
// Keeping the maths here (not inside the worklet entry) means tests can
// source-import it directly, and the worklet entry stays import-only of these
// helpers (no top-level export of the Processor — see the worklet header).
//
// ── Pitch / voltage convention (D6, 1V/oct) ──
//   The `cv` cable carries a bipolar value; for PITCH we treat it as
//   volts/octave with 12 equal-tempered semitones per octave, i.e.
//   1/12 V per semitone. The quantizer snaps an input voltage to the
//   NEAREST pitch that belongs to the selected scale, with the root pinned
//   at C = 0 V. Octaves repeat the scale's degree set, so e.g. a major
//   scale admits {0,2,4,5,7,9,11} semitones in every octave.

/** A scale = the set of semitone degrees (0..11) admitted within one octave,
 *  relative to the root (C = degree 0). Sorted ascending. */
export interface Scale {
  /** Stable id used in code/tests. */
  id: string;
  /** Human-readable name shown above the SCALE knob on the card. */
  name: string;
  /** Admitted semitone degrees 0..11 (ascending, root = 0). */
  degrees: readonly number[];
}

// The scale table. Order is the SCALE-knob order (index = knob value, 0-based).
// Major → the modes → chromatic → harmonic/melodic minor. Root = C / 0 V.
export const SAMPLE_HOLD_SCALES: readonly Scale[] = [
  { id: 'chromatic',  name: 'Chromatic',  degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major',      name: 'Major',      degrees: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor',      name: 'Minor',      degrees: [0, 2, 3, 5, 7, 8, 10] }, // natural minor / aeolian
  { id: 'dorian',     name: 'Dorian',     degrees: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian',   name: 'Phrygian',   degrees: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian',     name: 'Lydian',     degrees: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', degrees: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian',    name: 'Locrian',    degrees: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonic',   name: 'Harmonic Minor', degrees: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic',    name: 'Melodic Minor',  degrees: [0, 2, 3, 5, 7, 9, 11] },
] as const;

/** Index of the last selectable scale (max value of the `scale` param/knob). */
export const SAMPLE_HOLD_MAX_SCALE = SAMPLE_HOLD_SCALES.length - 1;

/** Clamp an arbitrary (possibly CV-modulated, possibly float) scale value to a
 *  valid scale index. */
export function clampScaleIndex(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v);
  if (r < 0) return 0;
  if (r > SAMPLE_HOLD_MAX_SCALE) return SAMPLE_HOLD_MAX_SCALE;
  return r;
}

/** Display name for a scale index (clamped). For the card label. */
export function scaleName(scaleIndex: number): string {
  return SAMPLE_HOLD_SCALES[clampScaleIndex(scaleIndex)]!.name;
}

/**
 * Quantize a 1V/oct voltage to the NEAREST note of the given scale.
 *
 * Pitch model: semitone = volts * 12. We find the nearest admitted semitone
 * (across all octaves) and convert back to volts (/12). The root is C = 0 V,
 * so degree 0 in every octave maps to integer-volt boundaries.
 *
 * Ties (exactly halfway between two admitted notes) round toward the HIGHER
 * note — deterministic + matches Math.round's half-up behaviour for the
 * chromatic case.
 *
 * @param volts        input voltage (1V/oct).
 * @param scaleIndex   index into SAMPLE_HOLD_SCALES (clamped).
 * @returns the quantized voltage (1V/oct), snapped to a scale note.
 */
export function quantizeVoltage(volts: number, scaleIndex: number): number {
  if (!Number.isFinite(volts)) return 0;
  const scale = SAMPLE_HOLD_SCALES[clampScaleIndex(scaleIndex)]!;
  const degrees = scale.degrees;

  // Work in semitones. Decompose into octave + fractional-within-octave so we
  // only have to search `degrees` (0..11) plus the wrap-around to the next
  // octave's degree 0 (== 12).
  const semis = volts * 12;
  const octave = Math.floor(semis / 12);
  const within = semis - octave * 12; // 0..12 (12 only at the exact boundary)

  // Candidate admitted semitones near `within`: every degree in this octave,
  // plus the next octave's root (degree 0 + 12) and the previous octave's
  // highest degree (degrees[last] - 12) so notes just below the octave line
  // can snap downward across the boundary.
  let bestSemi = octave * 12 + degrees[0]!;
  let bestDist = Infinity;
  const considerSemi = (s: number) => {
    const d = Math.abs(s - semis);
    // Round half toward the higher note (>= for the strictly-greater pick,
    // so a tie keeps the larger candidate): use a tiny bias.
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && s > bestSemi)) {
      bestDist = d;
      bestSemi = s;
    }
    void within;
  };
  // Previous octave top, this octave's degrees, next octave's root.
  considerSemi((octave - 1) * 12 + degrees[degrees.length - 1]!);
  for (const deg of degrees) considerSemi(octave * 12 + deg);
  considerSemi((octave + 1) * 12 + degrees[0]!);

  return bestSemi / 12;
}

/**
 * Rising-edge sample & hold + quantizer — the pure per-sample step. Stateless
 * by design: the caller threads `prevGate` + `held` through. Returns the new
 * latched value, the quantized latched value, and the new prevGate.
 *
 * Behaviour:
 *   * gateConnected === false  → PURE QUANTIZER: cvOut tracks the LIVE input
 *     continuously; cvQuant continuously quantizes the live input. The gate is
 *     ignored entirely (the patch has nothing driving it).
 *   * gateConnected === true   → SAMPLE & HOLD: on a rising edge of `gate`
 *     (crosses GATE_THRESHOLD upward) latch `cvIn`. Between edges hold the
 *     latched value. cvQuant = the latched value quantized.
 *
 * @param cvIn          live cv input sample.
 * @param gate          live gate input sample.
 * @param prevGate      previous gate sample (for edge detection).
 * @param held          currently held value.
 * @param gateConnected whether something is patched to gate_in (engine-level).
 * @param scaleIndex    selected scale.
 */
export const GATE_THRESHOLD = 0.5;

export interface ShStepResult {
  /** New held value (= cv_out). */
  held: number;
  /** Quantized held value (= cv_quant). */
  quant: number;
  /** Gate sample to remember for the next call's edge detection. */
  prevGate: number;
}

export function sampleHoldStep(
  cvIn: number,
  gate: number,
  prevGate: number,
  held: number,
  gateConnected: boolean,
  scaleIndex: number,
): ShStepResult {
  if (!gateConnected) {
    // Pure quantizer: pass cv through continuously.
    return {
      held: cvIn,
      quant: quantizeVoltage(cvIn, scaleIndex),
      prevGate: gate,
    };
  }
  // Sample & hold: latch on a rising edge.
  let nextHeld = held;
  if (gate >= GATE_THRESHOLD && prevGate < GATE_THRESHOLD) {
    nextHeld = cvIn;
  }
  return {
    held: nextHeld,
    quant: quantizeVoltage(nextHeld, scaleIndex),
    prevGate: gate,
  };
}
