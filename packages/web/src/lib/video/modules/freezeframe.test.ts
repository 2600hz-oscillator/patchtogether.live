// packages/web/src/lib/video/modules/freezeframe.test.ts
//
// FREEZEFRAME unit tests — pure (no GL):
//   1. def shape (5 video outs, video_in + gate_in, 4 QUANT knobs).
//   2. QUANT posterize mapping: 7:00→256, mid→32, max→2; monotonic.
//   3. posterizeChannel math (identity at 256, threshold at 2).
//   4. channel split / luma extraction (Rec.601 weights).
//   5. PHOSPHOR DECAY: the envelope's exact endpoints, renderer-independence of
//      the progress accumulator, and the 8-bit residue that the closed-form
//      design exists to avoid (kept as a permanent negative control).

import { describe, it, expect } from 'vitest';
import {
  quantLevels,
  posterizeChannel,
  lumaOf,
  shouldCapture,
  gateIsPatched,
  holdQualified,
  freezeframeDef,
  decayEnvelope,
  advanceDecayProgress,
  applyDecay,
  decayTargetValue,
  DECAY_MIN_S,
  DECAY_MAX_S,
  DECAY_DEFAULT_S,
  DECAY_FLOOR,
  DECAY_RATE,
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

  it('THE CEILING: the window is STRICTLY SHORTER than 4 bridge ticks', () => {
    // ⚠ THIS TEST EXISTS BECAUSE THE CONSTANT WAS UNPINNED FROM ABOVE.
    // Every other assertion about the qualify window is a LOWER bound (>= 2
    // ticks, > DEFAULT_GATE_LEN_S, > TRIGGER_PULSE_S), and every HELD-gate test
    // below derives its own frame counts FROM the constant — so the whole suite
    // was invariant to the window growing. Measured: at HOLD_QUALIFY_MS = 300,
    // 5000 or 60000 the entire file stayed GREEN, while a held gate froze for a
    // full minute after opening. The one user-visible latency this module
    // deliberately changed was the one quantity nothing bounded.
    //
    // WHY 4 TICKS IS THE CEILING. The window is pure added latency on a HELD
    // gate: the level cannot read as "continuous" until it has stood that long.
    // Past 4 ticks (100 ms) a 5 Hz square LFO — whose HIGH phase is 100 ms —
    // degenerates to exactly one captured frame per cycle, i.e. it stops
    // behaving like the "plays while open" gate the docs promise and becomes a
    // pure strobe. The behavioural half of this bound is the 5 Hz sweep below;
    // this is the structural half, so a future edit trips it at review time
    // rather than at render time.
    //
    // Floor (2 ticks) + tie-break (> 50 ms) + ceiling (< 100 ms) leave exactly
    // one value on the 25 ms tick grid: 75 ms.
    expect(
      HOLD_QUALIFY_MS,
      `qualify window vs the 4-tick ceiling (${4 * SCHEDULER_TICK_MS} ms) — a longer window turns a held gate into a strobe`,
    ).toBeLessThan(4 * SCHEDULER_TICK_MS);
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
  // ── WHICH GRID THE SWEEP HAS TO BEAT (corrected 2026-08-01) ──
  // An earlier version swept these phases against a 250 ms trigger period and
  // said they were "chosen CO-PRIME-ish to the FRAME grid". That named the wrong
  // grid, and the sweep was ~92 % decoration as a result.
  //
  // The mechanism the qualify window exists to suppress is the STAIRCASE ECHO:
  // the bridge re-reports the level once per SCHEDULER_TICK_MS, so a 5 ms pulse
  // produces a spurious whole-tick HIGH *only if a tick instant lands inside the
  // pulse*. Whether that happens is decided by the pulse's offset inside the
  // 25 ms TICK period — the frame grid decides only how many frames the echo
  // then covers. With a 250 ms trigger period (10 whole ticks) EVERY pulse in a
  // run sits at the SAME offset, and with these phases only one of six put a
  // tick inside a pulse at all. Measured: removing the qualify window entirely
  // (`qualifyMs: 0`) changed 3 of 36 cells. 33 cells could not tell the
  // window's presence from its absence.
  //
  // FIX: make the trigger period CO-PRIME TO THE TICK PERIOD. 241 ms is prime,
  // so successive pulses walk the whole 25 ms tick window (241 mod 25 = 16, a
  // generator of Z/25), and 10 triggers per run sample 10 distinct offsets. Now
  // every cell whose FRAME period is shorter than a tick — the only cells where
  // an echo can span a draw at all — is sensitive to the constant. Measured:
  // 24 of 36 cells change when the window is removed, and the 12 that don't are
  // exactly the 8 fps and 30 fps rows (125 ms and 33.3 ms per frame, both longer
  // than a 25 ms tick, so no draw can land inside the echo). The negative
  // control below asserts that predicate rather than a bare "some cells moved".
  const FPS = [8, 30, 60, 120, 165, 240];
  const PHASES = [0, 3, 7, 11, 17, 23];
  const TRIGGER_PERIOD_MS = 241; // PRIME → co-prime to SCHEDULER_TICK_MS (25)
  const TRIGGERS = 10;

  for (const fps of FPS) {
    for (const phaseMs of PHASES) {
      it(`${fps} fps, tick phase +${phaseMs} ms: ${TRIGGERS} triggers → EXACTLY ${TRIGGERS} updates`, () => {
        const r = runTriggerTimeline({
          framePeriodMs: 1000 / fps, triggerPeriodMs: TRIGGER_PERIOD_MS, triggers: TRIGGERS, phaseMs,
        });
        expect(r.triggersFired, `timeline actually delivered ${TRIGGERS} pulses`).toBe(TRIGGERS);
        expect(r.captures, `captures at ${fps} fps / phase ${phaseMs} ms`).toBe(TRIGGERS);
      });
    }
  }

  it('INSTRUMENT: the sweep is SENSITIVE to the qualify window it is testing', () => {
    // Negative-control the INSTRUMENT, not just the code: remove the qualify
    // window and the sweep must break wherever it physically can. If it does
    // not, these 36 cells are decoration — which is precisely what they were
    // before the trigger period was made co-prime to the tick.
    //
    // The predicate is exact, not a vague floor: an echo lasts one TICK period,
    // so a draw can only land inside it when the frame period is SHORTER than a
    // tick. Every such cell must differ; the rest cannot.
    const insensitiveButShould: string[] = [];
    const sensitiveButCant: string[] = [];
    for (const fps of FPS) {
      const framePeriodMs = 1000 / fps;
      const echoCanSpanADraw = framePeriodMs < SCHEDULER_TICK_MS;
      for (const phaseMs of PHASES) {
        const args = { framePeriodMs, triggerPeriodMs: TRIGGER_PERIOD_MS, triggers: TRIGGERS, phaseMs };
        const shipped = runTriggerTimeline(args).captures;
        const noWindow = runTriggerTimeline({ ...args, qualifyMs: 0 }).captures;
        const differs = shipped !== noWindow;
        if (echoCanSpanADraw && !differs) insensitiveButShould.push(`${fps}fps/phase${phaseMs} (=${shipped})`);
        if (!echoCanSpanADraw && differs) sensitiveButCant.push(`${fps}fps/phase${phaseMs} (${shipped}→${noWindow})`);
      }
    }
    expect(
      insensitiveButShould,
      `these cells have a frame period shorter than the ${SCHEDULER_TICK_MS} ms bridge tick, so removing the qualify window MUST change them — if it does not, the sweep cannot see the constant it is testing: ${insensitiveButShould.join(' ')}`,
    ).toEqual([]);
    expect(
      sensitiveButCant,
      `these cells draw more slowly than the bridge ticks, so no echo can span a draw and the window is unobservable — a difference here means the model changed: ${sensitiveButCant.join(' ')}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the pre-fix LEVEL-ONLY logic fails this same timeline', () => {
    // If this ever passes, the assertion above proves nothing — the timeline
    // would be satisfiable without edge detection at all.
    const bad = FPS.flatMap((fps) => PHASES.map((phaseMs) => runTriggerTimeline({
      framePeriodMs: 1000 / fps, triggerPeriodMs: TRIGGER_PERIOD_MS, triggers: TRIGGERS, phaseMs, levelOnly: true,
    }).captures));
    expect(bad.every((n) => n === TRIGGERS), `level-only captures across the sweep: [${bad.join(',')}]`).toBe(false);
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

  // -------------------------------------------------------------------------
  // THE UPPER BOUND, BEHAVIOURALLY. Everything above this line derives its frame
  // counts FROM HOLD_QUALIFY_MS, so all of it stays green at any window length —
  // measured green at 300 ms, 5 s and 60 s. These two assertions use ABSOLUTE
  // times taken from the BRIDGE cadence (SCHEDULER_TICK_MS) and from a stated
  // musical requirement, never from the constant under test, so they go red when
  // the window grows.
  // -------------------------------------------------------------------------

  /** A square LFO on the gate: `hz` cycles/s, 50 % duty, driven through the real
   *  bridge cadence (a scheduler tick every SCHEDULER_TICK_MS re-reports the
   *  level; the tick that sees the level go high also counts the rising edge).
   *  Returns how many of the drawn frames captured. */
  function runSquareGate(o: { fps: number; hz: number; cycles: number; qualifyMs?: number }): {
    captured: number; frames: number;
  } {
    const c = makeGateConsumer(false, o.qualifyMs);
    const framePeriodMs = 1000 / o.fps;
    const periodMs = 1000 / o.hz;
    const durationMs = periodMs * o.cycles;
    const high = (t: number): boolean => (t % periodMs) < periodMs / 2;
    const events: Array<{ t: number; kind: 'tick' | 'draw' }> = [];
    for (let t = 0; t < durationMs; t += SCHEDULER_TICK_MS) events.push({ t, kind: 'tick' });
    for (let t = 0; t < durationMs; t += framePeriodMs) events.push({ t, kind: 'draw' });
    events.sort((a, b) => a.t - b.t || (a.kind === 'tick' ? -1 : 1));
    let prevHigh = false;
    let captured = 0;
    let frames = 0;
    for (const e of events) {
      if (e.kind === 'tick') {
        const h = high(e.t);
        c.tick(h && !prevHigh ? 1 : 0, h ? 1 : 0, e.t);
        prevHigh = h;
      } else {
        frames++;
        const before = c.captures;
        c.draw(e.t);
        if (c.captures > before) captured++;
      }
    }
    return { captured, frames };
  }

  it('CEILING (behaviour): a 5 Hz square gate still PLAYS while open, it does not strobe', () => {
    // The doc promise for a held gate is "it updates CONTINUOUSLY for as long as
    // it stays high (so an LFO square plays while open then stutter-freezes the
    // instant it closes)". A 5 Hz square holds the gate high for 100 ms per
    // cycle. If the qualify window ever reaches that, the ONLY capture left in a
    // cycle is the one-shot at the rising edge and the module becomes a pure
    // strobe — the promise breaks with no test noticing, because every other
    // held-gate assertion scales itself by the window.
    //
    // CYCLES is the yardstick, deliberately: "captures > cycles" means "more
    // than the one-shot", which is exactly the qualitative claim.
    const CYCLES = 10;
    for (const fps of [60, 120, 240]) {
      const r = runSquareGate({ fps, hz: 5, cycles: CYCLES });
      expect(
        r.captured,
        `${fps} fps, 5 Hz square: ${r.captured} captures over ${CYCLES} cycles (${r.frames} frames). ` +
        'At most one per cycle means the qualify window has eaten the entire 100 ms high phase and the ' +
        'gate now strobes instead of playing.',
      ).toBeGreaterThan(CYCLES);
    }
  });

  it('NEGATIVE CONTROL: a 4-tick (100 ms) window turns that same 5 Hz square into a strobe', () => {
    // Proves the assertion above is sensitive to the constant it bounds — and
    // shows exactly where the ceiling comes from.
    const CYCLES = 10;
    const r = runSquareGate({ fps: 60, hz: 5, cycles: CYCLES, qualifyMs: 4 * SCHEDULER_TICK_MS });
    expect(
      r.captured,
      `at a ${4 * SCHEDULER_TICK_MS} ms window a 5 Hz square must collapse to one capture per cycle (got ${r.captured})`,
    ).toBeLessThanOrEqual(CYCLES);
    // …and the shipped window does NOT. Same timeline, one constant changed.
    expect(runSquareGate({ fps: 60, hz: 5, cycles: CYCLES }).captured).toBeGreaterThan(r.captured);
  });

  it('CEILING (latency): a held gate goes continuous within 4 bridge ticks of the rise', () => {
    // The one user-visible cost of the window, pinned in ABSOLUTE ms. The bound
    // is 4 ticks PLUS one frame period, because a renderer slower than the bound
    // cannot report a capture sooner than its own next frame (SwiftShader draws
    // at ~8 fps = 125 ms/frame, and that is a renderer fact, not a window fact).
    const CEILING_MS = 4 * SCHEDULER_TICK_MS; // 100
    for (const fps of [8, 60, 120, 240]) {
      const framePeriodMs = 1000 / fps;
      const frames = Math.ceil((CEILING_MS * 4) / framePeriodMs) + 10; // NOT derived from the window
      const got = runHeld(fps, frames);
      const firstSteadyIdx = got.findIndex((_, i) => got.slice(i).every(Boolean));
      expect(firstSteadyIdx, `${fps} fps: never went continuous — [${got.map((b) => (b ? 1 : 0)).join('')}]`)
        .toBeGreaterThanOrEqual(0);
      // runHeld puts the opening tick half a frame BEFORE frame 1, so the rise
      // is at framePeriodMs/2 — measure the latency from the rise, not from 0.
      const riseAtMs = framePeriodMs / 2;
      const sinceRiseMs = (firstSteadyIdx + 1) * framePeriodMs - riseAtMs;
      expect(
        sinceRiseMs,
        `${fps} fps: continuous only ${sinceRiseMs.toFixed(1)} ms after the rise — the ceiling is ` +
        `${CEILING_MS} ms + one frame (${framePeriodMs.toFixed(1)} ms), because a renderer cannot report ` +
        `sooner than its own next frame. Pattern [${got.map((b) => (b ? 1 : 0)).join('')}]`,
      ).toBeLessThanOrEqual(CEILING_MS + framePeriodMs);
    }
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

describe('freezeframe docs — the PROSE must not contradict the shipped behaviour', () => {
  // ⚠ WHY THIS EXISTS. `contract-lock` pins the CONTRACT SHAPE and
  // `module-docs-lint` pins KEY COVERAGE and vocabulary. Neither compares the
  // authored sentence to the factory, so the docs shipped saying a held gate
  // "updates CONTINUOUSLY for as long as it stays high" while the module in fact
  // waits HOLD_QUALIFY_MS first — and, at the GATEMAIDEN-derived width, updates
  // exactly ONE frame. Three measured contradictions the whole gate set missed:
  //     GATEMAIDEN default (50 ms gate) : promised continuous → actually 1 frame
  //     4 Hz square, 60 fps             : promised "plays"    → 26 % of frames
  //     1 Hz square, 60 fps             : promised continuous → 44 % of frames
  // A full prose-vs-behaviour gate is not buildable, but the two facts a reader
  // is actively misled without ARE checkable, and the NUMBER can be tied to the
  // constant so the doc cannot silently go stale when the window moves.
  const docs = freezeframeDef.docs;
  const gateProse = (): string =>
    `${docs?.explanation ?? ''}\n${docs?.inputs?.gate_in ?? ''}\n${docs?.controls?.gateLevel ?? ''}`;

  it('the authored prose states the qualification window, with the SHIPPED number', () => {
    const prose = gateProse();
    expect(prose.length, 'gate docs are authored at all').toBeGreaterThan(200);
    expect(
      prose,
      `the docs must quote the real window (${HOLD_QUALIFY_MS} ms). If HOLD_QUALIFY_MS moved, the ` +
      'prose is now wrong — re-author it and run `task docs:accept`.',
    ).toContain(`${HOLD_QUALIFY_MS} ms`);
    // …and no stale number from an earlier revision is left lying around.
    for (const stale of [50, 100, 25].filter((n) => n !== HOLD_QUALIFY_MS)) {
      expect(
        new RegExp(`\\b${stale} ms\\b(?![^.]*GATEMAIDEN)`).test(docs?.controls?.gateLevel ?? ''),
        `the gateLevel control doc quotes ${stale} ms, which is not the shipped window`,
      ).toBe(false);
    }
  });

  it('the authored prose states the GATEMAIDEN-derived-gate outcome', () => {
    // The commit message called this a FEATURE ("inserting GATEMAIDEN does not
    // change the frame count") and never wrote it into the doc the user reads —
    // while the doc simultaneously promised such a gate would run continuously.
    const prose = gateProse();
    expect(prose, 'the derived-gate case is documented').toMatch(/GATEMAIDEN/);
    expect(
      prose,
      `and its width (${DEFAULT_GATE_LEN_S * 1000} ms) is quoted, so the reader can see WHY it reads as a trigger`,
    ).toContain(`${DEFAULT_GATE_LEN_S * 1000} ms`);
  });

  it('the authored prose does not promise UNCONDITIONAL continuity', () => {
    // The exact sentence that was wrong. A held gate is continuous only AFTER
    // the window, so an unqualified "for as long as it stays high" is a false
    // statement about this module, however natural it reads.
    const explanation = docs?.explanation ?? '';
    expect(
      /updates CONTINUOUSLY for as long as it stays high/.test(explanation),
      'the docs make the unconditional-continuity claim again — it is false for the first ' +
      `${HOLD_QUALIFY_MS} ms after every rising edge`,
    ).toBe(false);
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

// ══════════════════════════════════════════════════════════════════════════
// PHOSPHOR DECAY
// ══════════════════════════════════════════════════════════════════════════

/** GL's float→UNORM8 conversion: round to NEAREST code value, clamp to 0..255
 *  (ES 3.0 §2.1.6.2). The residue simulation below needs to model what an FBO
 *  write actually STORES, and rounding-vs-truncation is the whole difference. */
function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

describe('decayEnvelope — the curve, and what DECAY TIME MEANS', () => {
  it('EXACT at both ends: a fresh frame is untouched, an elapsed one is GONE', () => {
    // The two assertions the whole design turns on, and both are `toBe`, not
    // `toBeCloseTo`: renormalizing the truncated exponential exists precisely so
    // the endpoints are EXACT rather than within-tolerance. "Reaches the target
    // and stays there" is the feature's acceptance criterion.
    expect(decayEnvelope(0), 'progress 0 → the held frame is untouched').toBe(1);
    expect(decayEnvelope(1), 'progress 1 → the target is REACHED, not approached').toBe(0);
  });

  it('stays at the target once past it (a long freeze does not revive the image)', () => {
    for (const p of [1, 1.5, 10, 1e6]) expect(decayEnvelope(p)).toBe(0);
  });

  it('is strictly monotonic-decreasing across the sweep', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 200; i++) {
      const k = decayEnvelope(i / 200);
      expect(k, `envelope must decrease at p=${i / 200}`).toBeLessThan(prev);
      prev = k;
    }
  });

  it('is EXPONENTIAL in shape, not linear — most brightness goes early', () => {
    // The distinguishing property of an exponential against a ramp: at the
    // halfway point far MORE than half the brightness is already gone (a linear
    // fade would read exactly 0.5). e^(-ln100/2) = 0.1, renormalized ≈ 0.0909.
    const half = decayEnvelope(0.5);
    expect(half).toBeCloseTo((Math.exp(-DECAY_RATE / 2) - DECAY_FLOOR) / (1 - DECAY_FLOOR), 12);
    expect(half, 'a linear ramp would read 0.5 here; this must be far below it').toBeLessThan(0.2);
  });

  it('THE KNOB CONVENTION: 1 % at the knob time, NOT the 37 % a 1/e reading leaves', () => {
    // The decision this test exists to pin (see decayEnvelope's doc comment). If
    // the curve is ever "simplified" to a plain 1/e time constant, DECAY TIME
    // silently starts meaning something else and the knob reads as broken — you
    // dial 0.5 s and half a second later a third of the picture is still up.
    expect(DECAY_RATE).toBeCloseTo(Math.log(100), 12);
    // The pre-renormalization exponential is AT the floor when the clock runs out…
    expect(Math.exp(-DECAY_RATE)).toBeCloseTo(DECAY_FLOOR, 12);
    // …and this is what the rejected convention would have left behind.
    expect(Math.exp(-1), 'the rejected reading, recorded so the choice stays legible')
      .toBeGreaterThan(0.36);
  });

  it('is TOTAL — a NaN or negative progress cannot leak a NaN uniform into GLSL', () => {
    expect(decayEnvelope(Number.NaN)).toBe(0);
    expect(decayEnvelope(Number.POSITIVE_INFINITY)).toBe(0);
    expect(decayEnvelope(-1)).toBe(1);
    for (const p of [0, 0.25, 0.5, 0.75, 1]) expect(Number.isFinite(decayEnvelope(p))).toBe(true);
  });
});

describe('advanceDecayProgress — RENDERER-INDEPENDENT by construction', () => {
  // The rule this feature was most likely to violate. CI's SwiftShader renders
  // at ~7.9 fps against ~60 on a real GPU, so anything accumulated PER FRAME is
  // a ~7.6× different time constant per machine — one assertion locally, a
  // different one on the runner. These are the direct negative control: the
  // same elapsed SECONDS, delivered in wildly different numbers of steps, must
  // produce the same decay.
  const runFor = (totalSec: number, steps: number, timeS: number): number => {
    let p = 0;
    for (let i = 0; i < steps; i++) p = advanceDecayProgress(p, totalSec / steps, timeS);
    return p;
  };

  it('1 step vs 600 steps over the SAME half-second land on the same progress', () => {
    const a = runFor(0.5, 1, 1);
    const b = runFor(0.5, 600, 1);
    expect(a).toBeCloseTo(0.5, 12);
    expect(b).toBeCloseTo(0.5, 12);
    expect(Math.abs(a - b), 'frame count must not change the answer').toBeLessThan(1e-12);
  });

  it.each([
    ['SwiftShader on CI', 7.9],
    ['a 60 Hz display', 60],
    ['a 120 Hz display', 120],
    ['a 240 Hz display', 240],
  ])('%s reaches the SAME brightness after the same wall-clock time', (_label, fps) => {
    // 0.25 s of real time — however many frames that renderer managed to draw.
    const steps = Math.max(1, Math.round(0.25 * fps));
    expect(decayEnvelope(runFor(0.25, steps, 0.5))).toBeCloseTo(decayEnvelope(0.5), 6);
  });

  it('NEGATIVE CONTROL: a PER-FRAME factor (the naive design) is renderer-dependent', () => {
    // The same 0.25 s and the same knob, decayed by a fixed factor each DRAW —
    // the shape the repo forbids. Here so the property above cannot be mistaken
    // for something that holds automatically.
    const perFrame = (fps: number): number => {
      let k = 1;
      for (let i = 0; i < Math.round(0.25 * fps); i++) k *= 0.96;
      return k;
    };
    // MEASURED: 15 frames at 60 fps vs 60 frames at 240 fps, same 0.25 s.
    expect(perFrame(60)).toBeCloseTo(0.542086, 5);
    expect(perFrame(240)).toBeCloseTo(0.086352, 5);
    expect(
      Math.abs(perFrame(60) - perFrame(240)),
      'the rejected design differs by 0.456 of FULL SCALE between two renderers',
    ).toBeGreaterThan(0.45);
  });

  it('reaches exactly 1 (fully decayed) after the knob time, and stops there', () => {
    expect(advanceDecayProgress(0, 2, 2)).toBe(1);
    expect(advanceDecayProgress(0.9, 100, 2)).toBe(1);
    expect(decayEnvelope(advanceDecayProgress(0, DECAY_MIN_S, DECAY_MIN_S))).toBe(0);
  });

  it('a MID-FADE knob move changes the RATE, and does not rewrite the past', () => {
    // Progress is travelled distance, so re-reading the knob cannot teleport the
    // brightness. Fade 0.25 s at a 1 s setting, then switch the knob to 2 s.
    const half = advanceDecayProgress(0, 0.25, 1);
    expect(half).toBeCloseTo(0.25, 12);
    const after = advanceDecayProgress(half, 0.25, 2);
    expect(after, 'the 0.25 already travelled is kept').toBeCloseTo(0.375, 12);
    // The age-based alternative would recompute 0.5 s / 2 s = 0.25 and the image
    // would JUMP BACK UP mid-fade. It must only ever move one way.
    expect(after).toBeGreaterThan(half);
  });

  it('clamps the knob to its declared range, so a bad param cannot divide by ~0', () => {
    expect(advanceDecayProgress(0, DECAY_MIN_S, 0)).toBe(1);
    expect(advanceDecayProgress(0, DECAY_MIN_S, -5)).toBe(1);
    expect(advanceDecayProgress(0, DECAY_MAX_S, 1e9)).toBeCloseTo(1, 12);
  });

  it('a NON-MONOTONIC clock cannot run the decay BACKWARDS', () => {
    // The determinism hook can be toggled mid-run, which steps frame.time
    // sideways. A negative or NaN dt must be inert, never a rewind.
    expect(advanceDecayProgress(0.4, -10, 1)).toBe(0.4);
    expect(advanceDecayProgress(0.4, Number.NaN, 1)).toBe(0.4);
  });
});

describe('applyDecay + the 8-BIT RESIDUE this design exists to avoid', () => {
  it('DECAY OFF is BIT-EXACT, not merely close', () => {
    // The off-state uniform pair is (k = 1, target = 0) and the shader tail is
    // the same affine form as applyDecay, so every representable 8-bit input
    // must come back as the IDENTICAL double. `toBe`, so a 1-ULP drift fails.
    for (let b = 0; b <= 255; b++) expect(applyDecay(b / 255, 1, 0)).toBe(b / 255);
  });

  it('reaches EXACTLY black for all 256 code values once the envelope hits 0', () => {
    for (let b = 0; b <= 255; b++) {
      expect(toByte(applyDecay(b / 255, decayEnvelope(1), decayTargetValue(false)))).toBe(0);
    }
  });

  it('reaches EXACTLY white for all 256 code values with INVERT on', () => {
    for (let b = 0; b <= 255; b++) {
      expect(toByte(applyDecay(b / 255, decayEnvelope(1), decayTargetValue(true)))).toBe(255);
    }
  });

  it('the two directions are SYMMETRIC — one curve, measured to the other end', () => {
    for (const p of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
      const k = decayEnvelope(p);
      const v = 0.42;
      expect(applyDecay(v, k, 0) / v, 'distance to BLACK shrinks by k').toBeCloseTo(k, 12);
      expect((1 - applyDecay(v, k, 1)) / (1 - v), 'distance to WHITE shrinks by k').toBeCloseTo(k, 12);
    }
  });

  it('NEGATIVE CONTROL: the naive PER-FRAME multiply STALLS on an 8-bit FBO', () => {
    // WHY THIS TEST IS PERMANENT. `ctx.createFbo()` allocates RGBA8
    // (VideoEngine.createFboImpl) and GL rounds a float write to the nearest
    // code value — so an iterative `v ← v·k` sticks wherever `round(v·k) == v`,
    // i.e. for every v ≤ 0.5/(1−k). The image fades to a dark ghost and sits
    // there FOREVER. That is what the closed-form uniform avoids, and this
    // simulation is the evidence, kept next to the thing it justifies so a
    // future "simplification" back to a feedback pass reads the measurement
    // before making it.
    //
    // Note the second finding in the same numbers: the residue is a function of
    // the FRAME RATE, because k is. The naive design is renderer-dependent in
    // its ENDPOINT as well as its rate.
    const residues: Record<number, number> = {};
    for (const fps of [60, 120, 240]) {
      const k = Math.exp(-(1 / fps) / (DECAY_MAX_S / DECAY_RATE));
      let byte = 255;
      for (let i = 0; i < 100_000; i++) {
        const next = toByte((byte / 255) * k);
        if (next === byte) break; // stalled
        byte = next;
      }
      residues[fps] = byte;
    }
    expect(residues, 'the stall point in 8-bit code values, per renderer').toEqual({
      60: 13,
      120: 26,
      240: 52,
    });
    // 52/255 is a fifth of full brightness left permanently on screen.
    expect(residues[240]! / 255).toBeGreaterThan(0.2);

    // …and the SHIPPED closed form, driven over the same elapsed time through
    // the same predicates the module calls, lands on 0 at every frame rate.
    for (const fps of [60, 120, 240]) {
      let p = 0;
      for (let i = 0; i < Math.round(DECAY_MAX_S * fps); i++) {
        p = advanceDecayProgress(p, 1 / fps, DECAY_MAX_S);
      }
      expect(toByte(applyDecay(1, decayEnvelope(p), 0)), `${fps} fps reaches black`).toBe(0);
    }
  });
});

describe('freezeframe def — the DECAY controls', () => {
  const param = (id: string) => freezeframeDef.params.find((p) => p.id === id);

  it('DECAY and INVERT are canonical 0/1 switches (the looksLikeToggle shape)', () => {
    for (const id of ['decay', 'decay_invert']) {
      const p = param(id);
      expect(p, `${id} is declared`).toBeDefined();
      expect(p!.curve).toBe('discrete');
      expect(p!.min).toBe(0);
      expect(p!.max).toBe(1);
      expect(p!.defaultValue, `${id} must default OFF — today's behaviour is the default`).toBe(0);
    }
  });

  it('DECAY TIME is the owner-specified 0.05..2 s range, on a log knob', () => {
    const p = param('decay_time');
    expect(p).toBeDefined();
    expect(p!.min, 'owner spec: 0.05 s').toBe(0.05);
    expect(p!.max, 'owner spec: 2 s').toBe(2);
    expect(p!.units).toBe('s');
    expect(p!.curve, 'a 40:1 sweep on a linear knob wastes its bottom half').toBe('log');
    expect(p!.defaultValue).toBe(DECAY_DEFAULT_S);
    expect(p!.defaultValue).toBeGreaterThanOrEqual(p!.min);
    expect(p!.defaultValue).toBeLessThanOrEqual(p!.max);
  });

  it("the exported range constants ARE the def's numbers (one source, not two)", () => {
    // The card reads its Fader bounds off the def and the def reads them off
    // these constants. A second copy anywhere is the backdraft defect.
    expect(param('decay_time')!.min).toBe(DECAY_MIN_S);
    expect(param('decay_time')!.max).toBe(DECAY_MAX_S);
  });

  it('adds NO new ports — the switches are panel controls, not jacks', () => {
    expect(freezeframeDef.inputs.map((p) => p.id)).toEqual(['video_in', 'gate_in']);
    expect(freezeframeDef.outputs).toHaveLength(5);
  });
});

describe('freezeframe DECAY docs — the caveat a user is misled without', () => {
  const docs = freezeframeDef.docs;

  it('every DECAY control is documented (the STRICT_DOCS completeness bar)', () => {
    for (const id of ['decay', 'decay_invert', 'decay_time']) {
      expect(docs?.controls?.[id]?.length ?? 0, `${id} needs authored prose`).toBeGreaterThan(80);
    }
  });

  it('the prose SAYS decay is only visible while frozen', () => {
    // The honest caveat: with GATE unpatched every frame is freshly captured, so
    // DECAY legitimately does nothing — and a user who does not know that reads
    // it as a dead control. Asserted on the switch's own doc, where they look.
    const prose = `${docs?.controls?.decay ?? ''} ${docs?.explanation ?? ''}`.toLowerCase();
    expect(prose).toMatch(/froze?n/);
    expect(prose).toMatch(/live passthrough|nothing you can see|unpatched/);
  });

  it("the prose states the knob's \"gone by\" reading, not a time constant", () => {
    const prose = (docs?.controls?.decay_time ?? '').toLowerCase();
    expect(prose).toMatch(/0\.05/);
    expect(prose).toMatch(/\b2 s\b|\b2 seconds\b/);
    // If the curve is ever re-read as 1/e, this sentence becomes a lie.
    expect(prose, 'the doc must not silently drift to a time-constant reading')
      .toMatch(/not a 1\/e time constant|37 percent/);
  });
});
