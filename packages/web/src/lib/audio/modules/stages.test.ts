// packages/web/src/lib/audio/modules/stages.test.ts
//
// STAGES unit tests — module-def shape + pure-math behaviour for each
// segment type, gate retrigger semantics, link chain handoff, and the
// SHAPE knob's effect on the RAMP curve.

import { describe, expect, it } from 'vitest';
import {
  stagesDef,
  stagesMath,
  STAGES_NUM_SEGMENTS,
  STAGES_NUM_LINKS,
  STAGES_NUM_TYPES,
  STAGES_TYPE_NAMES,
  TYPE_RAMP,
  TYPE_HOLD,
  TYPE_STEP,
  warpPhase,
  timeKnobToSeconds,
  computeChainLeaders,
  StagesEngine,
} from './stages';

const SR = 48000;

/** Build a 6-segment params array using the supplied overrides. */
function segs(
  override: Partial<Record<number, Partial<{ type: number; primary: number; shape: number }>>>,
): Array<{ type: number; primary: number; shape: number }> {
  const base = { type: TYPE_RAMP, primary: 0.3, shape: 0.5 };
  return Array.from({ length: STAGES_NUM_SEGMENTS }, (_, i) => ({ ...base, ...(override[i] ?? {}) }));
}

const NO_LINKS = new Array(STAGES_NUM_LINKS).fill(false);

describe('stagesDef shape', () => {
  it('declares type=stages, label=STAGES, category=modulation', () => {
    expect(stagesDef.type).toBe('stages');
    expect(stagesDef.label).toBe('STAGES');
    expect(stagesDef.category).toBe('modulation');
  });

  it('exposes 6 per-segment gate inputs + 1 global trig + per-segment CV inputs', () => {
    const ids = stagesDef.inputs.map((p) => p.id);
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      expect(ids).toContain(`gate${i}`);
      expect(ids).toContain(`primary${i}_cv`);
      expect(ids).toContain(`shape${i}_cv`);
    }
    expect(ids).toContain('trig');
  });

  it('exposes 6 per-segment CV outputs out0..out5', () => {
    const ids = stagesDef.outputs.map((p) => p.id);
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      expect(ids).toContain(`out${i}`);
      const port = stagesDef.outputs.find((p) => p.id === `out${i}`)!;
      expect(port.type).toBe('cv');
    }
  });

  it('exposes 6×3 segment params + 5 link bits = 23 params total', () => {
    const ids = stagesDef.params.map((p) => p.id);
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      expect(ids).toContain(`type${i}`);
      expect(ids).toContain(`primary${i}`);
      expect(ids).toContain(`shape${i}`);
    }
    for (let i = 0; i < STAGES_NUM_LINKS; i++) {
      expect(ids).toContain(`link${i}`);
    }
    expect(ids.length).toBe(STAGES_NUM_SEGMENTS * 3 + STAGES_NUM_LINKS);
  });

  it('every CV input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of stagesDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      expect(port.cvScale, `${port.id} cvScale`).toBeDefined();
      const param = stagesDef.params.find((p) => p.id === port.paramTarget);
      expect(param, `${port.id} → param ${port.paramTarget}`).toBeDefined();
    }
  });

  it('STAGES_TYPE_NAMES enumerates the three types in canonical order', () => {
    expect(STAGES_TYPE_NAMES).toEqual(['RAMP', 'HOLD', 'STEP']);
    expect(STAGES_NUM_TYPES).toBe(3);
  });
});

describe('warpPhase / Tides-style curve', () => {
  it('is linear at curve=0.5', () => {
    expect(warpPhase(0.0, 0.5)).toBeCloseTo(0, 6);
    expect(warpPhase(0.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(warpPhase(1.0, 0.5)).toBeCloseTo(1, 6);
  });

  it('curve > 0.5 bends above the diagonal at t=0.5 (fast / exp-like attack)', () => {
    // curve∈(0.5,1] flips=false, a=128(c-0.5)², so out at t=0.5 is
    // (1+a)*0.5 / (1+0.5a) > 0.5 for any a>0.
    expect(warpPhase(0.5, 0.9)).toBeGreaterThan(0.5);
  });

  it('curve < 0.5 bends below the diagonal at t=0.5 (slow / log-like attack)', () => {
    // curve∈[0,0.5) triggers the flip path: t becomes 1-t, the same
    // exp-like bend, then flip back → output below 0.5.
    expect(warpPhase(0.5, 0.1)).toBeLessThan(0.5);
  });

  it('endpoints are preserved regardless of curve', () => {
    for (const c of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      expect(warpPhase(0, c)).toBeCloseTo(0, 6);
      expect(warpPhase(1, c)).toBeCloseTo(1, 6);
    }
  });
});

describe('timeKnobToSeconds / log time mapping', () => {
  it('knob=0 → 1ms; knob=1 → 10s; knob=0.5 → ~100ms', () => {
    expect(timeKnobToSeconds(0)).toBeCloseTo(0.001, 6);
    expect(timeKnobToSeconds(1)).toBeCloseTo(10, 6);
    expect(timeKnobToSeconds(0.5)).toBeGreaterThan(0.05);
    expect(timeKnobToSeconds(0.5)).toBeLessThan(0.2);
  });
});

describe('computeChainLeaders / link bit → group membership', () => {
  it('all unlinked → every segment is its own leader', () => {
    expect(computeChainLeaders([false, false, false, false, false]))
      .toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('all linked → segment 0 leads all six', () => {
    expect(computeChainLeaders([true, true, true, true, true]))
      .toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('middle chain — 1↔2↔3 linked, 0/4/5 standalone', () => {
    expect(computeChainLeaders([false, true, true, false, false]))
      .toEqual([0, 1, 1, 1, 4, 5]);
  });
});

describe('RAMP segment / linear shape goes 0→1 over TIME seconds', () => {
  it('standalone RAMP segment outputs near 1.0 at the end of its TIME window', () => {
    // primary=0.3 → ~32ms time; we render 100ms and trigger at 0.
    const outs = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.3, shape: 0.5 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    const final = outs[0]![outs[0]!.length - 1]!;
    // After 100ms (which is well past 32ms), the ramp has completed.
    expect(final).toBeGreaterThan(0.95);
  });

  it('un-triggered RAMP stays at 0', () => {
    const outs = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.3, shape: 0.5 } }),
      links: NO_LINKS,
    });
    for (const v of outs[0]!) expect(v).toBe(0);
  });

  it('RAMP value is monotone non-decreasing during the ramp window', () => {
    const outs = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.5, shape: 0.5 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    let prev = -1;
    for (const v of outs[0]!) {
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = v;
    }
  });
});

describe('HOLD segment / constant output of LEVEL', () => {
  it('HOLD with LEVEL=0.7 settles at ~0.7', () => {
    // HOLD doesn't need a trigger — it just sits at its level (with
    // portamento from the initial value of 0). Allow 500ms to settle.
    const outs = stagesMath.render(SR, SR, {
      segments: segs({ 0: { type: TYPE_HOLD, primary: 0.7, shape: 0.0 } }),
      links: NO_LINKS,
    });
    const tail = outs[0]![outs[0]!.length - 1]!;
    expect(tail).toBeCloseTo(0.7, 2);
  });

  it('HOLD with LEVEL=-0.5 settles at ~-0.5', () => {
    const outs = stagesMath.render(SR, SR, {
      segments: segs({ 0: { type: TYPE_HOLD, primary: -0.5, shape: 0.0 } }),
      links: NO_LINKS,
    });
    const tail = outs[0]![outs[0]!.length - 1]!;
    expect(tail).toBeCloseTo(-0.5, 2);
  });
});

describe('STEP segment / sample-and-hold of LEVEL on gate', () => {
  it('STEP holds its LEVEL after a gate trigger', () => {
    const outs = stagesMath.render(SR, SR, {
      segments: segs({ 0: { type: TYPE_STEP, primary: 0.4, shape: 0.0 } }),
      links: NO_LINKS,
      segmentTriggers: [[100], [], [], [], [], []],
    });
    // Immediately after the trigger, STEP value = LEVEL. With portamento=0
    // it should settle within a few samples; allow 1ms for settling.
    const probe = outs[0]![100 + Math.floor(SR * 0.005)]!;
    expect(probe).toBeCloseTo(0.4, 2);
  });

  it('changing LEVEL between triggers updates the held value on the next trigger', () => {
    const engine = new StagesEngine(SR);
    engine.setSegmentType(0, TYPE_STEP);
    engine.setSegmentPrimary(0, 0.2);
    engine.setSegmentShape(0, 0.0);
    const gate = new Float32Array(STAGES_NUM_SEGMENTS);
    // Trigger #1: hold 0.2
    gate[0] = 1;
    engine.tick(gate, 0);
    gate[0] = 0;
    for (let i = 0; i < 200; i++) engine.tick(gate, 0);
    expect(engine.outValues[0]!).toBeCloseTo(0.2, 2);
    // Trigger #2: change level then trigger
    engine.setSegmentPrimary(0, 0.8);
    gate[0] = 1;
    engine.tick(gate, 0);
    gate[0] = 0;
    for (let i = 0; i < 200; i++) engine.tick(gate, 0);
    expect(engine.outValues[0]!).toBeCloseTo(0.8, 2);
  });
});

describe('Gate retrigger semantics', () => {
  it('a second gate during an active RAMP restarts the ramp from its current value', () => {
    // Long-ish ramp; trigger at 0, retrigger at midway, the second ramp
    // should still reach near 1.0 by the end.
    const outs = stagesMath.render(SR / 2, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.4, shape: 0.5 } }),
      links: NO_LINKS,
      segmentTriggers: [[0, Math.floor(SR * 0.05)], [], [], [], [], []],
    });
    // At end (250ms), the ramp (retriggered at 50ms, time ~63ms) is done.
    const final = outs[0]![outs[0]!.length - 1]!;
    expect(final).toBeGreaterThan(0.9);
  });

  it('global TRIG fires every chain group leader', () => {
    const engine = new StagesEngine(SR);
    // Three independent (unlinked) segments, all RAMP.
    for (let i = 0; i < 3; i++) {
      engine.setSegmentType(i, TYPE_RAMP);
      engine.setSegmentPrimary(i, 0.3);
    }
    const gate = new Float32Array(STAGES_NUM_SEGMENTS);
    // Global TRIG rising edge at sample 0.
    engine.tick(gate, 1);
    // Run 50ms — each independent RAMP should be progressing.
    for (let i = 0; i < SR * 0.05; i++) engine.tick(gate, 0);
    for (let i = 0; i < 3; i++) {
      expect(engine.outValues[i]!, `seg ${i} running after global TRIG`)
        .toBeGreaterThan(0.1);
    }
  });
});

describe('Linking chains 2+ segments correctly', () => {
  it('seg0=RAMP linked to seg1=HOLD produces an AHD-like shape', () => {
    // RAMP→HOLD: first RAMP runs from 0 to HOLD level, then HOLD pins.
    const links = [true, false, false, false, false];
    const outs = stagesMath.render(SR, SR, {
      segments: segs({
        0: { type: TYPE_RAMP, primary: 0.3, shape: 0.5 },
        1: { type: TYPE_HOLD, primary: 0.6, shape: 0.0 },
      }),
      links,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    // After 500ms, we should be sitting near the HOLD level of 0.6
    // (RAMP duration ≈ 32ms, then HOLD takes over).
    const late = outs[0]![Math.floor(SR * 0.5)]!;
    expect(late).toBeCloseTo(0.6, 1);
  });

  it('all-linked 6-segment chain runs to completion when triggered', () => {
    // 6 short RAMPs linked, fired by global TRIG. Each RAMP at primary=0
    // is 1ms; the whole chain should complete in <10ms.
    const links = [true, true, true, true, true];
    const outs = stagesMath.render(SR / 10, SR, {
      segments: Array.from({ length: STAGES_NUM_SEGMENTS }, () => ({
        type: TYPE_RAMP, primary: 0.0, shape: 0.5,
      })),
      links,
      globalTriggers: [0],
    });
    // After 100ms, all segments have completed; value sits at 1.0.
    const final = outs[0]![outs[0]!.length - 1]!;
    expect(final).toBeGreaterThan(0.95);
  });

  it('non-leader segment\'s gate is ignored (only leader\'s gate fires the chain)', () => {
    // Link seg0↔seg1. Trigger seg1's gate — should NOT advance the chain.
    const links = [true, false, false, false, false];
    const outs = stagesMath.render(SR / 4, SR, {
      segments: segs({
        0: { type: TYPE_RAMP, primary: 0.3, shape: 0.5 },
        1: { type: TYPE_HOLD, primary: 0.7, shape: 0.0 },
      }),
      links,
      segmentTriggers: [[], [0], [], [], [], []],
    });
    // Chain leader is seg0; gating seg1 should not start the chain.
    // Output should remain at 0 (or settle to HOLD via portamento, but
    // since the chain hasn't started, the HOLD segment isn't active).
    const sample = outs[0]![100]!;
    expect(sample).toBeLessThan(0.1);
  });
});

describe('SHAPE knob bends the RAMP curve', () => {
  it('SHAPE > 0.5 lifts the ramp above the linear line (fast attack)', () => {
    // Linear ramp vs fast (curve=0.9) — fast curve is higher mid-ramp.
    const linear = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.4, shape: 0.5 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    const fast = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.4, shape: 0.9 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    const probe = Math.floor(SR * 0.03);
    expect(fast[0]![probe]!).toBeGreaterThan(linear[0]![probe]!);
  });

  it('SHAPE < 0.5 sinks the ramp below the linear line (slow attack)', () => {
    const linear = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.4, shape: 0.5 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    const slow = stagesMath.render(SR / 4, SR, {
      segments: segs({ 0: { type: TYPE_RAMP, primary: 0.4, shape: 0.1 } }),
      links: NO_LINKS,
      segmentTriggers: [[0], [], [], [], [], []],
    });
    const probe = Math.floor(SR * 0.03);
    expect(slow[0]![probe]!).toBeLessThan(linear[0]![probe]!);
  });
});

describe('Numerical safety', () => {
  it('finite output across mixed-type 6-segment chain', () => {
    const outs = stagesMath.render(SR / 2, SR, {
      segments: [
        { type: TYPE_RAMP, primary: 0.2, shape: 0.3 },
        { type: TYPE_HOLD, primary: 0.5, shape: 0.5 },
        { type: TYPE_STEP, primary: -0.5, shape: 0.5 },
        { type: TYPE_RAMP, primary: 0.4, shape: 0.7 },
        { type: TYPE_HOLD, primary: 1.0, shape: 0.0 },
        { type: TYPE_STEP, primary: 0.0, shape: 0.0 },
      ],
      links: [true, true, true, true, true],
      globalTriggers: [0],
    });
    for (let s = 0; s < STAGES_NUM_SEGMENTS; s++) {
      for (let i = 0; i < outs[s]!.length; i++) {
        const v = outs[s]![i]!;
        expect(Number.isFinite(v), `seg=${s} sample=${i} v=${v}`).toBe(true);
        expect(Math.abs(v)).toBeLessThan(2);
      }
    }
  });
});

describe('stagesMath.knobLabels', () => {
  it('RAMP → TIME / SHAPE', () => {
    expect(stagesMath.knobLabels(TYPE_RAMP)).toEqual({ primary: 'TIME', shape: 'SHAPE' });
  });
  it('HOLD → LEVEL / PORTA', () => {
    expect(stagesMath.knobLabels(TYPE_HOLD)).toEqual({ primary: 'LEVEL', shape: 'PORTA' });
  });
  it('STEP → LEVEL / PORTA', () => {
    expect(stagesMath.knobLabels(TYPE_STEP)).toEqual({ primary: 'LEVEL', shape: 'PORTA' });
  });
});
