// packages/web/src/lib/video/modules/freezeframe.test.ts
//
// FREEZEFRAME unit tests — pure (no GL):
//   1. def shape (5 video outs, video_in + gate_in, 4 QUANT knobs).
//   2. QUANT posterize mapping: 7:00→256, mid→32, max→2; monotonic.
//   3. posterizeChannel math (identity at 256, threshold at 2).
//   4. channel split / luma extraction (Rec.601 weights).

import { describe, it, expect } from 'vitest';
import {
  quantLevels,
  posterizeChannel,
  lumaOf,
  shouldCapture,
  gateIsPatched,
  holdQualified,
  freezeframeDef,
  LUMA_WEIGHTS,
  QUANT_MAX_LEVELS,
  QUANT_MID_LEVELS,
  QUANT_MIN_LEVELS,
  GATE_PATCH_GRACE,
  GATE_PATCH_GRACE_MS,
  HOLD_QUALIFY_MS,
  type CaptureInputs,
} from './freezeframe';
import { detectEdge, makeEdgeState } from '$lib/doom/cv-gate-edge';
import { GATE_HI, TRIGGER_PULSE_S, DEFAULT_GATE_LEN_S } from '$lib/audio/gate-trigger';
import { SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';

describe('quantLevels mapping (256 -> 32 -> 2)', () => {
  it('7:00 / min knob = 0 → 256 levels (full depth)', () => {
    expect(quantLevels(0)).toBeCloseTo(QUANT_MAX_LEVELS, 6);
    expect(quantLevels(0)).toBeCloseTo(256, 6);
  });

  it('midway knob = 0.5 → 32 levels', () => {
    expect(quantLevels(0.5)).toBeCloseTo(QUANT_MID_LEVELS, 6);
    expect(quantLevels(0.5)).toBeCloseTo(32, 6);
  });

  it('max knob = 1 → 2 levels (on/off)', () => {
    expect(quantLevels(1)).toBeCloseTo(QUANT_MIN_LEVELS, 6);
    expect(quantLevels(1)).toBeCloseTo(2, 6);
  });

  it('step count is STRICTLY monotonic-decreasing across the sweep', () => {
    let prev = Infinity;
    for (let k = 0; k <= 1.00001; k += 0.05) {
      const lv = quantLevels(k);
      expect(lv, `levels at knob=${k.toFixed(2)} (${lv}) < prev (${prev})`).toBeLessThan(prev);
      prev = lv;
    }
  });

  it('clamps out-of-range knob values', () => {
    expect(quantLevels(-1)).toBeCloseTo(256, 6);
    expect(quantLevels(2)).toBeCloseTo(2, 6);
  });
});

describe('posterizeChannel', () => {
  it('256 levels is effectively identity for representable 8-bit grid values', () => {
    // Values on the 256-step grid round-trip to themselves.
    for (const n of [0, 64, 128, 200, 255]) {
      const v = n / 255;
      // posterize to 256 buckets, then it sits on the 256-grid (idx/255).
      const out = posterizeChannel(v, 256);
      expect(out).toBeCloseTo(n / 255, 5);
    }
  });

  it('2 levels is a hard threshold to {0, 1}', () => {
    expect(posterizeChannel(0.0, 2)).toBe(0);
    expect(posterizeChannel(0.4, 2)).toBe(0);
    expect(posterizeChannel(0.49, 2)).toBe(0);
    expect(posterizeChannel(0.5, 2)).toBe(1);
    expect(posterizeChannel(0.9, 2)).toBe(1);
    expect(posterizeChannel(1.0, 2)).toBe(1);
  });

  it('reduces the number of DISTINCT output values as levels drop', () => {
    const distinct = (levels: number) => {
      const s = new Set<number>();
      for (let i = 0; i <= 255; i++) s.add(posterizeChannel(i / 255, levels));
      return s.size;
    };
    const at256 = distinct(256);
    const at32 = distinct(32);
    const at2 = distinct(2);
    expect(at32).toBeLessThan(at256);
    expect(at2).toBeLessThan(at32);
    expect(at2).toBe(2);          // exactly {0, 1}
    expect(at32).toBe(32);        // 32 buckets reachable from 256 inputs
  });

  it('clamps + never divides by zero (levels < 2 floored to 2)', () => {
    expect(posterizeChannel(0.7, 1)).toBe(1);   // treated as 2 levels
    expect(posterizeChannel(0.7, 0)).toBe(1);
    expect(Number.isFinite(posterizeChannel(0.3, 2))).toBe(true);
  });

  it('spans the full 0..1 output range (white in → white out)', () => {
    expect(posterizeChannel(1, 32)).toBeCloseTo(1, 6);
    expect(posterizeChannel(1, 256)).toBeCloseTo(1, 6);
    expect(posterizeChannel(0, 32)).toBe(0);
  });
});

const CAP = (o: Partial<CaptureInputs>): CaptureInputs => ({
  gatePatched: true, gateLevel: 0, holdSeeded: true, triggerArmed: false, levelQualified: true, ...o,
});

describe('shouldCapture — sample & hold gate logic', () => {
  it('always captures the first frame (seeds the hold buffer)', () => {
    // holdSeeded=false → capture regardless of gate state.
    expect(shouldCapture(CAP({ gatePatched: false, holdSeeded: false }))).toBe(true);
    expect(shouldCapture(CAP({ holdSeeded: false }))).toBe(true);            // patched + low, unseeded
    expect(shouldCapture(CAP({ holdSeeded: false, gateLevel: 1 }))).toBe(true);
  });

  it('UNPATCHED gate → always live passthrough (capture every frame)', () => {
    expect(shouldCapture(CAP({ gatePatched: false, gateLevel: 0 }))).toBe(true);
    expect(shouldCapture(CAP({ gatePatched: false, gateLevel: 1 }))).toBe(true);
    expect(shouldCapture(CAP({ gatePatched: false, gateLevel: 0.5 }))).toBe(true);
  });

  it('PATCHED gate HELD HIGH (>= GATE_HI) → capture (continuous while open)', () => {
    expect(shouldCapture(CAP({ gateLevel: GATE_HI }))).toBe(true);
    expect(shouldCapture(CAP({ gateLevel: 0.9 }))).toBe(true);
    expect(shouldCapture(CAP({ gateLevel: 1 }))).toBe(true);
  });

  it('PATCHED gate LOW (< GATE_HI), no edge → freeze (hold last frame)', () => {
    expect(shouldCapture(CAP({ gateLevel: 0 }))).toBe(false);
    expect(shouldCapture(CAP({ gateLevel: 0.49 }))).toBe(false);
  });

  it('a RISING EDGE captures even though the level is already back LOW', () => {
    // THE REGRESSION. A trigger's HIGH is gone before the draw; only the latch
    // survives. A level-only decision returns false here — that is the bug.
    expect(shouldCapture(CAP({ gateLevel: 0, triggerArmed: true }))).toBe(true);
  });

  it('an LFO square on the gate plays-while-high then freezes-when-low', () => {
    expect(shouldCapture(CAP({ gateLevel: 1 }))).toBe(true);  // open: updates
    expect(shouldCapture(CAP({ gateLevel: 0 }))).toBe(false); // closed: frozen
    expect(shouldCapture(CAP({ gateLevel: 1 }))).toBe(true);  // reopened: updates
  });

  it('an UNQUALIFIED high (a trigger\'s one-tick staircase echo) does NOT capture', () => {
    // The level says 1, but it has not yet survived a second bridge write, so
    // it is indistinguishable from a 5 ms pulse that straddled a tick. The
    // one-shot latch already gave this edge its single frame.
    expect(shouldCapture(CAP({ gateLevel: 1, levelQualified: false }))).toBe(false);
    // ...and the latch still wins on the frame the edge lands.
    expect(shouldCapture(CAP({ gateLevel: 1, levelQualified: false, triggerArmed: true }))).toBe(true);
  });
});

describe('holdQualified — HELD vs the staircase echo of a TRIGGER', () => {
  it('a level with no observed rise (already high when patched) qualifies at once', () => {
    expect(holdQualified(0, Number.NEGATIVE_INFINITY)).toBe(true);
  });

  it('qualifies only after HOLD_QUALIFY_MS since the rise', () => {
    expect(holdQualified(1000 + HOLD_QUALIFY_MS - 1, 1000)).toBe(false);
    expect(holdQualified(1000 + HOLD_QUALIFY_MS, 1000)).toBe(true);
  });

  it('THE TIE-BREAK: the window is STRICTLY longer than a trigger-DERIVED gate', () => {
    // `DEFAULT_GATE_LEN_S` is the width GATEMAIDEN widens a trigger to. At 2
    // ticks the qualify window was EXACTLY that width, which put such a gate
    // precisely ON the boundary — see HOLD_QUALIFY_MS's header for the
    // arithmetic. STRICT inequality is the whole decision: it is what makes
    // "trigger → GATEMAIDEN → FREEZEFRAME" produce the same frame count as
    // "trigger → FREEZEFRAME". If either constant moves, this goes red.
    expect(HOLD_QUALIFY_MS, `qualify window vs DEFAULT_GATE_LEN_S (${DEFAULT_GATE_LEN_S * 1000} ms)`)
      .toBeGreaterThan(DEFAULT_GATE_LEN_S * 1000);
  });

  it('the window is at least 2 bridge ticks and far longer than a trigger pulse', () => {
    // The bridge re-reports the level once per SCHEDULER_TICK_MS and we hold
    // the last report between ticks, so a trigger can read HIGH for one whole
    // tick period. Anything <= 1 tick would let that echo qualify as a hold.
    expect(HOLD_QUALIFY_MS).toBeGreaterThanOrEqual(2 * SCHEDULER_TICK_MS);
    expect(HOLD_QUALIFY_MS).toBeGreaterThan(TRIGGER_PULSE_S * 1000);
  });
});

describe('gateIsPatched — freshness of the bridge write (UNITS matter)', () => {
  const at = (ageMs: number, ageFrames: number): boolean =>
    gateIsPatched({ nowMs: 1000 + ageMs, lastWriteMs: 1000, frame: ageFrames, lastWriteFrame: 0 });

  it('never written → unpatched', () => {
    expect(gateIsPatched({
      nowMs: 5000, lastWriteMs: Number.NEGATIVE_INFINITY, frame: 900, lastWriteFrame: -1_000_000,
    })).toBe(false);
  });

  it('a write within the ms grace reads PATCHED however many frames elapsed', () => {
    expect(at(0, 0)).toBe(true);
    expect(at(GATE_PATCH_GRACE_MS, 10_000)).toBe(true);
  });

  it('stale beyond BOTH graces → unpatched (a pulled cable goes live again)', () => {
    expect(at(GATE_PATCH_GRACE_MS + 1, GATE_PATCH_GRACE + 1)).toBe(false);
  });

  it('the ms grace comfortably exceeds the bridge write cadence', () => {
    // The `gate` path replays on the scheduler tick; the `cv` path writes once
    // per video frame. Both must be far inside the grace.
    expect(GATE_PATCH_GRACE_MS).toBeGreaterThan(SCHEDULER_TICK_MS * 10);
  });

  it('REGRESSION: a 120 Hz display no longer reads UNPATCHED between ticks', () => {
    // 120 fps = 8.33 ms/frame; the bridge writes every SCHEDULER_TICK_MS (25),
    // i.e. every 3.0 frames — exactly the old frame-only grace, so any jitter
    // tipped it to "unpatched" and leaked a LIVE frame into a frozen image.
    // At 165 Hz it is 4.1 frames and it failed outright.
    for (const fps of [60, 120, 165, 240]) {
      const framesBetweenWrites = Math.ceil((SCHEDULER_TICK_MS / 1000) * fps);
      const patched = gateIsPatched({
        nowMs: SCHEDULER_TICK_MS, lastWriteMs: 0,
        frame: framesBetweenWrites, lastWriteFrame: 0,
      });
      expect(patched, `${fps} fps: ${framesBetweenWrites} frames between 25 ms bridge writes`).toBe(true);
    }
  });

  it('the FRAME grace still covers a renderer slower than the ms grace', () => {
    // SwiftShader on CI measures ~8 fps (125 ms/frame). A stalled 4 fps frame
    // gap is 250 ms; a 2-frame gap is 500 ms — the ms grace alone would be on
    // the edge, so the frame floor carries it.
    expect(gateIsPatched({ nowMs: 1200, lastWriteMs: 0, frame: 3, lastWriteFrame: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE CONTRACT, driven by the REAL bridge's write sequence.
//
// `PatchEngine.installGateDispatch` does NOT stream the gate waveform. It counts
// rising edges in the audio thread and REPLAYS them on the ~25 ms scheduler tick
// as `setParam(0); setParam(1)` per counted edge, then `setParam(currentLevel)`.
// Measured on the real chain (SEQUENCER.clock → FREEZEFRAME.gate_in), one pulse
// arrives as three writes inside the SAME millisecond: 0, 1, 0.
//
// So this simulator is not a guess about the bridge — it is that literal
// sequence, interleaved with draws at a chosen frame rate and PHASE.
// ---------------------------------------------------------------------------

/** Faithful CPU mirror of FREEZEFRAME's gate handling (the factory's setParam +
 *  draw, minus GL). `levelOnly` reproduces the PRE-FIX logic — the negative
 *  control that proves these assertions can actually fail. */
function makeGateConsumer(levelOnly = false, qualifyMs: number = HOLD_QUALIFY_MS) {
  const edge = makeEdgeState();
  let armed = false;
  let level = 0;
  let writeMs = Number.NEGATIVE_INFINITY;
  let riseMs = Number.NEGATIVE_INFINITY;
  let writeFrame = -1_000_000;
  let frame = -1;
  let seeded = false;
  let captures = 0;

  /** One setParam('gateLevel', v) — exactly what the bridge calls. */
  function write(v: number, nowMs: number): void {
    level = v;
    writeMs = nowMs;
    writeFrame = frame;
    if (detectEdge(edge, v)?.pressed === true) { armed = true; riseMs = nowMs; }
  }

  return {
    /** ONE scheduler tick of installGateDispatch. */
    tick(edges: number, curLevel: number, nowMs: number): void {
      for (let i = 0; i < edges; i++) { write(0, nowMs); write(1, nowMs); }
      write(curLevel, nowMs);
    },
    /** ONE video frame. Returns whether it captured. */
    draw(nowMs: number): boolean {
      frame++;
      const gatePatched = gateIsPatched({ nowMs, lastWriteMs: writeMs, frame, lastWriteFrame: writeFrame });
      const capture = levelOnly
        ? (!seeded || !gatePatched || level >= GATE_HI)
        : shouldCapture({
            gatePatched,
            gateLevel: level,
            holdSeeded: seeded,
            triggerArmed: armed,
            levelQualified: holdQualified(nowMs, riseMs, qualifyMs),
          });
      armed = false;
      if (capture) { seeded = true; captures++; }
      return capture;
    },
    get captures() { return captures; },
  };
}

/**
 * Run a timeline: video draws every `framePeriodMs`, scheduler ticks every
 * SCHEDULER_TICK_MS, and a trigger pulse of TRIGGER_PULSE_S every
 * `triggerPeriodMs`. `phaseMs` shifts the tick grid against the frame grid.
 * Returns captures made AFTER the seeding draw.
 */
function runTriggerTimeline(o: {
  framePeriodMs: number; triggerPeriodMs: number; triggers: number; phaseMs: number; levelOnly?: boolean;
  /** Pulse WIDTH. Defaults to a real short trigger; set to DEFAULT_GATE_LEN_S ×
   *  1000 to model a gate DERIVED from a trigger (GATEMAIDEN's widening) — the
   *  case that sat exactly on the qualify boundary. */
  pulseMs?: number;
  /** Override the qualify window (negative-control lever only). */
  qualifyMs?: number;
  /** Deterministic PER-TICK lateness bound, in ms. The tick is a Worker timer,
   *  so a loaded main thread delivers it late — and a late callback is what
   *  leaves a STALE HIGH report standing past the qualify boundary. Without it
   *  the timeline lands exactly ON the tie and resolves the same way for BOTH
   *  windows, so the negative control would be vacuous.
   *
   *  ⚠ IT MUST VARY PER TICK. A UNIFORM lateness shifts the whole tick grid,
   *  which is indistinguishable from a PHASE change — and phase is already
   *  swept, so a uniform jitter perturbs nothing new and the negative control
   *  silently passes (measured: 216/216 cells still exactly N). The observed
   *  HIGH lasts `gateWidth + late(k+2) − late(k)`, so only a tick that is MORE
   *  late than the one that reported the rise can extend it past the boundary.
   *  Lateness is therefore a low-discrepancy (golden-ratio) sequence of the tick
   *  index — deterministic, zero-flake, and genuinely non-uniform. */
  tickJitterMs?: number;
}): { captures: number; triggersFired: number } {
  const c = makeGateConsumer(o.levelOnly, o.qualifyMs);
  const pulseMs = o.pulseMs ?? TRIGGER_PULSE_S * 1000;
  const jitter = o.tickJitterMs ?? 0;
  const durationMs = o.triggerPeriodMs * (o.triggers + 1);
  const pulseAt = (k: number): number => o.triggerPeriodMs * (k + 1) + 0.5;

  // Seed: one draw before any trigger, with the bridge already writing 0 so
  // the gate reads PATCHED (this is the real "cable in, level low" state).
  c.tick(0, 0, 0);
  c.draw(0);

  const events: Array<{ t: number; kind: 'tick' | 'draw' }> = [];
  // Per-tick lateness: golden-ratio low-discrepancy in [0, jitter). Bounded
  // strictly under one tick period so the actual tick times stay ORDERED.
  const lateAt = (k: number): number => jitter * ((k * 0.61803398874989) % 1);
  let tickIdx = 0;
  for (let t = SCHEDULER_TICK_MS + o.phaseMs; t < durationMs; t += SCHEDULER_TICK_MS) {
    events.push({ t: t + lateAt(tickIdx++), kind: 'tick' });
  }
  for (let t = o.framePeriodMs; t < durationMs; t += o.framePeriodMs) events.push({ t, kind: 'draw' });
  events.sort((a, b) => a.t - b.t || (a.kind === 'tick' ? -1 : 1));

  let edgesSeen = 0;
  let triggersFired = 0;
  for (const e of events) {
    if (e.kind === 'tick') {
      // Edges the audio-thread counter accumulated since the previous tick.
      let edges = 0;
      let lvl = 0;
      for (let k = 0; k < o.triggers; k++) {
        const start = pulseAt(k);
        if (start <= e.t) { if (k >= edgesSeen) { edges++; edgesSeen = k + 1; triggersFired++; } }
        if (e.t >= start && e.t < start + pulseMs) lvl = 1;
      }
      c.tick(edges, lvl, e.t);
    } else {
      c.draw(e.t);
    }
  }
  return { captures: c.captures - 1 /* drop the seeding draw */, triggersFired };
}

describe('TRIGGER → exactly ONE frame (the real installGateDispatch sequence)', () => {
  // Frame rates spanning CI's SwiftShader floor to a 240 Hz display, and tick
  // phases chosen CO-PRIME-ish to the frame grid so no run can pass by lucky
  // alignment (an even phase against a periodic signal aliases to a constant).
  const FPS = [8, 30, 60, 120, 165, 240];
  const PHASES = [0, 3, 7, 11, 17, 23];

  for (const fps of FPS) {
    for (const phaseMs of PHASES) {
      it(`${fps} fps, tick phase +${phaseMs} ms: 6 triggers → EXACTLY 6 updates`, () => {
        const r = runTriggerTimeline({
          framePeriodMs: 1000 / fps, triggerPeriodMs: 250, triggers: 6, phaseMs,
        });
        expect(r.triggersFired, 'timeline actually delivered 6 pulses').toBe(6);
        expect(r.captures, `captures at ${fps} fps / phase ${phaseMs} ms`).toBe(6);
      });
    }
  }

  it('NEGATIVE CONTROL: the pre-fix LEVEL-ONLY logic fails this same timeline', () => {
    // If this ever passes, the assertion above proves nothing — the timeline
    // would be satisfiable without edge detection at all.
    const bad = FPS.flatMap((fps) => PHASES.map((phaseMs) => runTriggerTimeline({
      framePeriodMs: 1000 / fps, triggerPeriodMs: 250, triggers: 6, phaseMs, levelOnly: true,
    }).captures));
    expect(bad.every((n) => n === 6), `level-only captures across the sweep: [${bad.join(',')}]`).toBe(false);
    // And the headline shape of the owner's report: at the common phases the
    // level-only consumer sees NOTHING at all.
    expect(bad.some((n) => n === 0), `level-only produced zero updates somewhere: [${bad.join(',')}]`).toBe(true);
  });

  it('a trigger burst FASTER than the frame rate still updates at most one frame per frame', () => {
    // 8 fps (125 ms/frame) with a trigger every 30 ms: the latch is a boolean,
    // so several edges inside one frame interval collapse to ONE update. The
    // ceiling is the number of frames, never the number of edges.
    const r = runTriggerTimeline({ framePeriodMs: 125, triggerPeriodMs: 30, triggers: 20, phaseMs: 0 });
    expect(r.captures).toBeLessThanOrEqual(Math.ceil((30 * 21) / 125) + 1);
    expect(r.captures, 'the burst still produced updates').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDARY: a gate DERIVED from a trigger at the canonical default width.
//
// `DEFAULT_GATE_LEN_S` (50 ms) is what GATEMAIDEN widens a trigger to. With the
// qualify window at 2 ticks it was EXACTLY 50 ms too, so such a gate sat on the
// tie and its classification hung on scheduler jitter. The decision (see
// HOLD_QUALIFY_MS) resolves it DOWNWARD — a derived gate at that width is a
// TRIGGER — and the invariant that buys is:
//
//     inserting GATEMAIDEN into the path must NOT change the frame count.
//
// ⚠ INSTRUMENT NOTE. A jitter-free timeline lands exactly ON the tie and
// resolves the same way for BOTH windows (the tick that drops the level fires
// before the draw at the same instant), so a jitter-free negative control
// CANNOT FAIL — it would be pure decoration. The sweep therefore includes
// deterministic tick LATENESS, which is the real mechanism that flips the tie:
// a late Worker callback leaves the stale HIGH report standing past the
// boundary. The negative control below proves the sweep is sensitive to the one
// constant under test.
// ---------------------------------------------------------------------------
describe('DERIVED GATE at DEFAULT_GATE_LEN_S → still EXACTLY ONE frame (the boundary)', () => {
  const DERIVED_GATE_MS = DEFAULT_GATE_LEN_S * 1000; // 50
  const FPS = [8, 30, 60, 120, 165, 240];
  const PHASES = [0, 3, 7, 11, 17, 23];
  // Sub-tick lateness only: a callback a WHOLE period late is coalesced by the
  // scheduler, and no finite window can be proof against unbounded stalls.
  const JITTERS = [0, 1, 4, 9, 16, 20];
  const GATES = 6;

  function sweep(qualifyMs?: number): Array<{ fps: number; phaseMs: number; jitterMs: number; captures: number }> {
    const out: Array<{ fps: number; phaseMs: number; jitterMs: number; captures: number }> = [];
    for (const fps of FPS) for (const phaseMs of PHASES) for (const jitterMs of JITTERS) {
      const r = runTriggerTimeline({
        framePeriodMs: 1000 / fps, triggerPeriodMs: 250, triggers: GATES,
        phaseMs, pulseMs: DERIVED_GATE_MS, tickJitterMs: jitterMs, qualifyMs,
      });
      expect(r.triggersFired, 'timeline delivered every derived gate').toBe(GATES);
      out.push({ fps, phaseMs, jitterMs, captures: r.captures });
    }
    return out;
  }

  it(`${6 * 6 * 6} cells (fps × tick phase × tick lateness): EXACTLY ${GATES} updates for ${GATES} derived gates`, () => {
    const bad = sweep().filter((c) => c.captures !== GATES);
    expect(
      bad.length,
      `cells that did NOT deliver exactly ${GATES}: ${bad
        .map((c) => `${c.fps}fps/phase${c.phaseMs}/late${c.jitterMs}=${c.captures}`)
        .join(' ')}`,
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: the 2-tick window (the TIE) fails this same sweep', () => {
    // If this ever passes, the sweep above is invariant to HOLD_QUALIFY_MS and
    // proves nothing about the boundary decision.
    const tie = sweep(2 * SCHEDULER_TICK_MS); // 50 ms — exactly DEFAULT_GATE_LEN_S
    const over = tie.filter((c) => c.captures !== GATES);
    expect(
      over.length,
      `at the tie every cell delivered exactly ${GATES} — the sweep cannot see the constant it is testing`,
    ).toBeGreaterThan(0);
    // And the shape of the failure is EXTRA frames (the stale HIGH qualified),
    // never fewer — the one-shot latch still fires in both worlds.
    expect(
      over.every((c) => c.captures > GATES),
      `tie-window captures: ${over.map((c) => `${c.fps}fps/phase${c.phaseMs}/late${c.jitterMs}=${c.captures}`).join(' ')}`,
    ).toBe(true);
  });

  it('a real 5 ms TRIGGER is unaffected by the widened window', () => {
    // The tie-break moved the window; it must not have disturbed the case the
    // fix exists for. Same sweep, real trigger width.
    for (const fps of FPS) for (const jitterMs of JITTERS) {
      const r = runTriggerTimeline({
        framePeriodMs: 1000 / fps, triggerPeriodMs: 250, triggers: GATES,
        phaseMs: 7, tickJitterMs: jitterMs,
      });
      expect(r.captures, `${fps} fps / tick late ${jitterMs} ms`).toBe(GATES);
    }
  });
});

describe('HELD GATE → continuous (the one-shot must not swallow the hold)', () => {
  /** Gate opens at t=0 and stays HIGH. Returns the per-frame capture pattern
   *  over `frames` frames (frame 1 is the first frame after the rise). */
  function runHeld(fps: number, frames: number, levelOnly = false): boolean[] {
    const c = makeGateConsumer(levelOnly);
    const framePeriodMs = 1000 / fps;
    c.tick(0, 0, 0);
    c.draw(0);                                 // seed (gate patched, level low)
    const got: boolean[] = [];
    for (let i = 1; i <= frames; i++) {
      const t = i * framePeriodMs;
      // The bridge tick that opened the gate, then it stays HIGH and is
      // RE-REPORTED every scheduler tick (which is what makes it a HOLD).
      c.tick(i === 1 ? 1 : 0, 1, t - framePeriodMs / 2);
      got.push(c.draw(t));
    }
    return got;
  }

  for (const fps of [8, 60, 120, 240]) {
    it(`${fps} fps: a held-high gate ends up updating EVERY frame`, () => {
      const framePeriodMs = 1000 / fps;
      // Long enough that the qualify window is comfortably behind us.
      const frames = Math.ceil((HOLD_QUALIFY_MS * 3) / framePeriodMs) + 10;
      const got = runHeld(fps, frames);
      // Every frame from the qualify point on MUST capture — that is the
      // "continuous while held" half of the contract, and it is what a
      // trigger-only fix would have broken.
      const qualifyFrame = Math.ceil(HOLD_QUALIFY_MS / framePeriodMs);
      const tail = got.slice(qualifyFrame + 1);
      expect(tail.length, 'the tail window is non-empty (instrument check)').toBeGreaterThan(5);
      expect(tail.every(Boolean), `frames after qualify: [${tail.map((b) => (b ? 1 : 0)).join('')}]`).toBe(true);
      // And the rising edge itself updated a frame immediately — no visible
      // gap while the hold qualifies.
      expect(got[0], 'the frame at the rising edge captured (one-shot)').toBe(true);
    });
  }

  it('the hold qualifies within ~HOLD_QUALIFY_MS, not later', () => {
    const got = runHeld(240, 60); // 4.17 ms/frame → qualify ≈ frame 12
    const firstSteadyIdx = got.findIndex((_, i) => got.slice(i).every(Boolean));
    expect(firstSteadyIdx, `capture pattern: [${got.map((b) => (b ? 1 : 0)).join('')}]`)
      .toBeLessThanOrEqual(Math.ceil(HOLD_QUALIFY_MS / (1000 / 240)) + 2);
  });

  it('the gate DROPPING low freezes immediately on the next frame', () => {
    // Times are DERIVED from HOLD_QUALIFY_MS, not hardcoded: this timeline is a
    // statement about the qualify RULE, and a hardcoded one silently becomes a
    // different assertion whenever the constant moves (it did — 50 → 75).
    const Q = HOLD_QUALIFY_MS;
    const RISE = 10;
    const c = makeGateConsumer();
    c.tick(0, 0, 0); c.draw(0);
    // opened → the one-shot latch captures regardless of qualification
    c.tick(1, 1, RISE); expect(c.draw(RISE + 6), 'rising edge → one-shot').toBe(true);
    // held HIGH but still inside the qualify window → frozen
    c.tick(0, 1, RISE + Q * 0.4); expect(c.draw(RISE + Q * 0.5), 'still qualifying').toBe(false);
    c.tick(0, 1, RISE + Q * 0.8); expect(c.draw(RISE + Q * 0.9), 'still qualifying').toBe(false);
    // past the window with the level still high → continuous
    c.tick(0, 1, RISE + Q); expect(c.draw(RISE + Q + 5), 'qualified → continuous').toBe(true);
    c.tick(0, 1, RISE + Q + 25); expect(c.draw(RISE + Q + 30), 'stays continuous').toBe(true);
    // dropped → frozen again on the very next frame
    c.tick(0, 0, RISE + Q + 50); expect(c.draw(RISE + Q + 55), 'dropped → frozen').toBe(false);
    c.tick(0, 0, RISE + Q + 75); expect(c.draw(RISE + Q + 80), 'stays frozen').toBe(false);
  });
});

describe('freezeframe def — gate_in declares its edge semantic', () => {
  it('gate_in is a gate cable declared edge:"gate" targeting gateLevel', () => {
    const p = freezeframeDef.inputs?.find((i) => i.id === 'gate_in');
    expect(p, 'gate_in exists').toBeTruthy();
    expect(p!.type).toBe('gate');
    // 'gate' (not 'trigger'): the level IS read (held high = continuous live),
    // so declaring 'trigger' would promise the hold is ignored. The one-shot is
    // an ADDITIONAL guarantee on the same port.
    expect(p!.edge).toBe('gate');
    expect(p!.paramTarget).toBe('gateLevel');
  });
});

describe('lumaOf — Rec.601 channel extraction', () => {
  it('uses the 0.299 / 0.587 / 0.114 weights', () => {
    expect(LUMA_WEIGHTS).toEqual({ r: 0.299, g: 0.587, b: 0.114 });
  });

  it('pure red → 0.299, pure green → 0.587, pure blue → 0.114', () => {
    expect(lumaOf(1, 0, 0)).toBeCloseTo(0.299, 6);
    expect(lumaOf(0, 1, 0)).toBeCloseTo(0.587, 6);
    expect(lumaOf(0, 0, 1)).toBeCloseTo(0.114, 6);
  });

  it('white → 1, black → 0', () => {
    expect(lumaOf(1, 1, 1)).toBeCloseTo(1, 6);
    expect(lumaOf(0, 0, 0)).toBe(0);
  });

  it('green contributes more than red, red more than blue (perceptual order)', () => {
    expect(lumaOf(0, 1, 0)).toBeGreaterThan(lumaOf(1, 0, 0));
    expect(lumaOf(1, 0, 0)).toBeGreaterThan(lumaOf(0, 0, 1));
  });
});
