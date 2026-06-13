// packages/web/src/lib/audio/gate-trigger.ts
//
// The shared trigger ↔ gate semantic model + the canonical thresholds and
// emitted waveforms. One source of truth so every module agrees on what a
// "trigger" and a "gate" ARE — mirrors the `$lib/audio/midi-timing` precedent
// (one util every bridge must use).
//
// Hardware grounding (see .myrobots/plans/io-trigger-gate-sanitization.md §2):
// in Eurorack a gate and a trigger are the SAME binary CV — the only
// difference is TIME. A TRIGGER is a very short pulse that STARTS an event
// (the receiver fires once on the rising edge and ignores the fall). A GATE
// is held high for as long as the event is active (the receiver acts WHILE
// the level is high — sustain a note, hold a VCA open — and reacts to both
// edges). The cable is identical; the *consumer's* interpretation differs.
//
// In our graph all triggers + gates flow through the unified `gate` cable
// (graph/types.ts) — cross-patching gate↔trigger stays legal (it's just CV).
// What's NEW is a DECLARED semantic on input ports (`edge: 'trigger' | 'gate'`)
// so the model is explicit and lintable instead of re-derived per module.

/** Canonical HIGH threshold for edge/level detection (0..1 normalized CV).
 *  Matches every existing detector (`createRisingEdgeDetector(0.5)`,
 *  `createTransportCv` 0.5, the worklet per-sample `>= 0.5` checks). */
export const GATE_HI = 0.5;

/** Hysteresis LOW threshold. Equal to GATE_HI today (single-threshold,
 *  windowing-only — the proven fix for the overlap-rescan double-count needs
 *  no hysteresis). Kept as a named constant so a future module can opt into a
 *  Schmitt-trigger band (GATE_LO < GATE_HI) for noisy/slow ramps without
 *  re-deriving the number. */
export const GATE_LO = 0.5;

/** Default short-trigger pulse width — 5 ms, within the real-hardware 1–5 ms
 *  band. A trigger out is unambiguously a strike at this width. */
export const TRIGGER_PULSE_S = 0.005;

/** Default minimum width of a gate DERIVED from a trigger (trigger→gate
 *  widening, e.g. GATEMAIDEN). 50 ms — long enough to open a VCA / fire an
 *  envelope attack audibly. */
export const DEFAULT_GATE_LEN_S = 0.05;

/** The declared interpretation of an input port. Drives edge-vs-level:
 *   - 'trigger' → fire ONCE per rising edge (ignore how long it stays high)
 *   - 'gate'    → act WHILE the level is high; react to both edges
 *  Outputs may also carry this to drive the cosmetic ▷/▭ port glyph + the
 *  emitted waveform shape. */
export type EdgeSemantic = 'trigger' | 'gate';

/** Emit a short TRIGGER pulse onto a ConstantSource's offset param — a clean
 *  single crossing of GATE_HI then back to 0. Default shape is a triangle
 *  (linear up to 1 over width/2, back down to 0); 'square' is a flat-top
 *  pulse. `atSec` is an AudioContext time. */
export function fireTrigger(
  cs: ConstantSourceNode,
  atSec: number,
  widthSec: number = TRIGGER_PULSE_S,
  shape: 'triangle' | 'square' = 'triangle',
): void {
  const p = cs.offset;
  const w = Math.max(0.0005, widthSec);
  p.setValueAtTime(0, atSec);
  if (shape === 'triangle') {
    p.linearRampToValueAtTime(1, atSec + w / 2);
    p.linearRampToValueAtTime(0, atSec + w);
  } else {
    p.setValueAtTime(1, atSec);
    p.setValueAtTime(0, atSec + w);
  }
}

/** Open a GATE (held square) on a ConstantSource's offset at `atSec`. */
export function openGate(cs: ConstantSourceNode, atSec: number): void {
  cs.offset.setValueAtTime(1, atSec);
}

/** Close a GATE on a ConstantSource's offset at `atSec`. */
export function closeGate(cs: ConstantSourceNode, atSec: number): void {
  cs.offset.setValueAtTime(0, atSec);
}
