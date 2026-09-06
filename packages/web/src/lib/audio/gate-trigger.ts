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

// ── pulseTriggerNow: the "fire a trigger RIGHT NOW" primitive ───────────────
//
// ⚠ A SCHEDULED PAIR AT `currentTime` CAN RENDER AS NOTHING, and on an
// affected boot it does so for EVERY pulse. Measured (2026-09-05, CDP CPU
// throttle ×20 reproducing CI shard load; the gibribbon evt_kill recovered
// flake on run 34004453604): with the context RUNNING and its clock advancing
// 1:1 with wall time,
//
//   setValueAtTime(1, ct); setValueAtTime(0, ct + 0.01)   → peak 0.0000
//     — on the module's gate AND on a freshly created ConstantSource, for
//       134 pulses / 30 s straight;
//   setValueAtTime(1, ct) alone (a lone step)              → peak 1.0000
//   offset.value = 1 (direct write)                        → peak 1.0000
//
// The render frontier (the frames the audio thread has already produced) can
// LEAD the main-thread-visible `currentTime` by more than the pulse width,
// persistently for a whole boot — events behind the frontier collapse to
// their FINAL value, which for a rise+fall pair is 0, so the pulse never
// exists. A lone step survives the same collapse because its final value IS
// the payload. No amount of re-reading the clock between the two inserts
// fixes it (verified — the lag is not caller jitter).
//
// So the NOW-pulse never schedules: it writes the RISE as a direct value (the
// form measured to always render), then writes the FALL only after the
// context has RENDERED at least the requested width of audio since the rise —
// rendered progress, not wall clock, so the frontier lead cancels out of the
// difference and a starved main thread WIDENS the pulse instead of losing
// it. A wider gate is still exactly one rising edge to every detector, and
// merging retriggers while high is what hardware gates do.
//
// Scheduled callers (sequencers with lookahead, `fireTrigger(cs, futureT)`)
// are NOT affected — their event times sit safely ahead of the frontier.

/** Live fall-monitors, one per node — a retrigger extends, never stacks. */
const livePulses = new WeakMap<
  ConstantSourceNode,
  { riseCt: number; riseWall: number; timer: ReturnType<typeof setInterval> }
>();

/** One render quantum of slack past the requested width, so the fall can
 *  never land inside the same quantum that carries the rise. */
const PULSE_RENDER_SLACK_S = 0.003;

/** Wall-clock BACKSTOP for the fall monitor — it BOUNDS THE FAILURE, it is
 *  not the gate: a context whose clock stopped advancing (device teardown,
 *  suspend) must not leave the line latched high forever. */
const PULSE_FALL_BACKSTOP_MS = 2000;

/** Fall-monitor cadence. The timer lives only while a pulse is high
 *  (~widthSec + slack on a healthy context). */
const PULSE_MONITOR_MS = 5;

/** Emit a trigger pulse on a ConstantSource's offset STARTING IMMEDIATELY —
 *  the render-robust replacement for `fireTrigger(cs, ac.currentTime)` /
 *  a hand-rolled `setValueAtTime(1, now); setValueAtTime(0, now + w)` pair.
 *  See the mechanism note above. Retriggering while high extends the pulse
 *  (the first call's `widthSec` keeps governing an extended pulse). */
export function pulseTriggerNow(
  cs: ConstantSourceNode,
  widthSec: number = TRIGGER_PULSE_S,
): void {
  const ac = cs.context;
  // The level is DRIVEN BY VALUE WRITES, never by timeline events — clear any
  // stale automation so a leftover scheduled step cannot fight the writes.
  try { cs.offset.cancelScheduledValues(0); } catch { /* param torn down */ }
  cs.offset.value = 1;
  const live = livePulses.get(cs);
  if (live) {
    // Retrigger while high: stay high, extend from the fresh rise. The line
    // is already 1 so no downstream edge existed to lose.
    live.riseCt = ac.currentTime;
    live.riseWall = Date.now();
    return;
  }
  const state = {
    riseCt: ac.currentTime,
    riseWall: Date.now(),
    timer: setInterval(() => {
      const renderedS = ac.currentTime - state.riseCt;
      const stalled = Date.now() - state.riseWall >= PULSE_FALL_BACKSTOP_MS;
      if (renderedS < widthSec + PULSE_RENDER_SLACK_S && !stalled) return;
      cs.offset.value = 0;
      clearInterval(state.timer);
      livePulses.delete(cs);
    }, PULSE_MONITOR_MS),
  };
  livePulses.set(cs, state);
}

/** Open a GATE (held square) on a ConstantSource's offset at `atSec`. */
export function openGate(cs: ConstantSourceNode, atSec: number): void {
  cs.offset.setValueAtTime(1, atSec);
}

/** Close a GATE on a ConstantSource's offset at `atSec`. */
export function closeGate(cs: ConstantSourceNode, atSec: number): void {
  cs.offset.setValueAtTime(0, atSec);
}
