import { describe, expect, it } from 'vitest';
import {
  PhasesDSP,
  PHASES_DEFAULT_VERTICES,
  PHASES_MAX_PHASES,
  deletePhasesVertex,
  evaluatePhasesEnvelope,
  evaluatePhasesShape,
  getPhasesPhaseIndex,
  insertPhasesVertex,
  phasesLengthFromCv,
  sanitizePhasesVertices,
  type PhasesVertex,
} from './phases-dsp';

const RAMP: PhasesVertex[] = [{ x: 0, y: 0, shape: 0 }, { x: 1, y: 1, shape: 0 }];
const MULTI: PhasesVertex[] = [
  { x: 0, y: 0, shape: 0 },
  { x: 0.2, y: 1, shape: 0 },
  { x: 0.7, y: 0.4, shape: 0 },
  { x: 1, y: 0.8, shape: 0 },
];

function ramp(rate = 1000, length = 1): PhasesDSP {
  const engine = new PhasesDSP(rate, RAMP);
  engine.setLength(length);
  return engine;
}

function advance(engine: PhasesDSP, samples: number): void {
  for (let i = 0; i < samples; i++) engine.step();
}

describe('Phases editor geometry shared with audio', () => {
  it('starts with one flat zero-volt phase and permanent endpoints', () => {
    const vertices = sanitizePhasesVertices(undefined);
    expect(vertices).toEqual(PHASES_DEFAULT_VERTICES);
    expect(vertices).not.toBe(PHASES_DEFAULT_VERTICES);
    expect(evaluatePhasesEnvelope(vertices, 0.43)).toBe(0);
  });

  it('keeps unequal horizontal widths: the short attack and long decay do not get redistributed', () => {
    expect(evaluatePhasesEnvelope(MULTI, 0.1)).toBeCloseTo(0.5);
    expect(evaluatePhasesEnvelope(MULTI, 0.2)).toBe(1);
    expect(evaluatePhasesEnvelope(MULTI, 0.45)).toBeCloseTo(0.7);
    expect(evaluatePhasesEnvelope(MULTI, 0.85)).toBeCloseTo(0.6);
  });

  it('morphs linear to concave at noon and convex at full turn', () => {
    expect(evaluatePhasesShape(0.5, 0)).toBe(0.5);
    expect(evaluatePhasesShape(0.5, 0.5)).toBe(0.75);
    expect(evaluatePhasesShape(0.5, 1)).toBe(0.25);
    expect(evaluatePhasesShape(0.5, 0.75)).toBe(0.5);
    for (let shape = 0; shape <= 1; shape += 0.05) {
      let previous = 0;
      expect(evaluatePhasesShape(0, shape)).toBe(0);
      expect(evaluatePhasesShape(1, shape)).toBe(1);
      for (let i = 0; i <= 100; i++) {
        const value = evaluatePhasesShape(i / 100, shape);
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(1);
        previous = value;
      }
    }
    expect(Math.abs(evaluatePhasesShape(0.35, 0.500001) - evaluatePhasesShape(0.35, 0.499999))).toBeLessThan(1e-5);
  });

  it('keeps each phase shape independent and bounds rising, falling and flat phases', () => {
    const vertices = [
      { x: 0, y: 0, shape: 0.5 },
      { x: 0.25, y: 1, shape: 1 },
      { x: 0.75, y: 0.4, shape: 0.5 },
      { x: 1, y: 0.4, shape: 0 },
    ];
    expect(evaluatePhasesEnvelope(vertices, 0.125)).toBe(0.75);
    expect(evaluatePhasesEnvelope(vertices, 0.5)).toBeCloseTo(0.85);
    expect(evaluatePhasesEnvelope(vertices, 0.875)).toBe(0.4);
    expect(vertices.map((v) => evaluatePhasesEnvelope(vertices, v.x))).toEqual(vertices.map((v) => v.y));
  });

  it('inserts at the clicked x and curve height, retaining the left shape and existing data', () => {
    const source = [{ x: 0, y: 0, shape: 0.5 }, { x: 1, y: 1, shape: 0 }];
    const result = insertPhasesVertex(source, 0.125);
    expect(result).toEqual([
      { x: 0, y: 0, shape: 0.5 },
      { x: 0.125, y: 0.234375, shape: 0 },
      { x: 1, y: 1, shape: 0 },
    ]);
    expect(source).toHaveLength(2);
    expect(insertPhasesVertex(result, 0.125)).toHaveLength(3);
    expect(insertPhasesVertex(result, 0)).toHaveLength(3);
    expect(insertPhasesVertex(result, 1)).toHaveLength(3);
  });

  it('deletes an interior vertex and merges with the LEFT original phase shape', () => {
    const source = [
      { x: 0, y: 0, shape: 0.2 },
      { x: 0.2, y: 1, shape: 0.9 },
      { x: 0.7, y: 0.4, shape: 0.6 },
      { x: 1, y: 0.8, shape: 0 },
    ];
    expect(deletePhasesVertex(source, 1)).toEqual([source[0], source[2], source[3]]);
    expect(deletePhasesVertex(source, 2)).toEqual([source[0], source[1], source[3]]);
    for (const index of [0, 3, -1, 1.5, NaN]) expect(deletePhasesVertex(source, index)).toEqual(source);
    expect(source).toHaveLength(4);
  });

  it('allows exactly 24 phases, then allows another insertion after deletion', () => {
    let vertices = sanitizePhasesVertices(RAMP);
    for (let i = 1; i < PHASES_MAX_PHASES; i++) vertices = insertPhasesVertex(vertices, i / PHASES_MAX_PHASES);
    expect(vertices).toHaveLength(25);
    expect(insertPhasesVertex(vertices, 0.0125)).toEqual(vertices);
    vertices = deletePhasesVertex(vertices, 1);
    expect(insertPhasesVertex(vertices, 0.0125)).toHaveLength(25);
  });

  it('normalizes malformed data without losing terminal endpoints or allowing zero-width phases', () => {
    const vertices = sanitizePhasesVertices([
      null, { x: NaN, y: 1 }, { x: 0.6, y: 2, shape: -1 },
      { x: 0.2, y: NaN, shape: Infinity }, { x: 0.2, y: 0.7, shape: 1 },
    ]);
    expect(vertices).toEqual([
      { x: 0, y: 0, shape: 0 }, { x: 0.2, y: 0, shape: 0 },
      { x: 0.6, y: 1, shape: 0 }, { x: 1, y: 1, shape: 0 },
    ]);
    const oversized = sanitizePhasesVertices(Array.from({ length: 40 }, (_, i) => ({ x: i / 39, y: i / 39, shape: 0.6 })));
    expect(oversized).toHaveLength(25);
    expect(oversized[0]!.x).toBe(0);
    expect(oversized[24]!.x).toBe(1);
    expect(evaluatePhasesEnvelope(oversized, 0.99)).toBeLessThan(1);
  });

  it('owns exact phase boundaries in the direction being entered', () => {
    expect(getPhasesPhaseIndex(MULTI, 0.2)).toBe(1);
    expect(getPhasesPhaseIndex(MULTI, 0.2, true)).toBe(0);
    expect(getPhasesPhaseIndex(MULTI, 0.7)).toBe(2);
    expect(getPhasesPhaseIndex(MULTI, 0.7, true)).toBe(1);
    for (const reverse of [false, true]) {
      expect(getPhasesPhaseIndex(MULTI, 0, reverse)).toBe(0);
      expect(getPhasesPhaseIndex(MULTI, 1, reverse)).toBe(2);
    }
  });
});

describe('Phases transport', () => {
  it('is idle on spawn and a held Trigger plays once, holding the terminal CV', () => {
    const engine = ramp(1000, 0.05);
    expect(engine.step()).toBe(0);
    expect(engine.playing).toBe(false);
    const output = Array.from({ length: 70 }, () => engine.step(1));
    expect(output[0]).toBe(0);
    expect(output[25]).toBeCloseTo(0.5);
    expect(output.slice(50)).toEqual(Array(20).fill(1));
    expect(engine.position).toBe(1);
    expect(engine.playing).toBe(false);
    engine.step(0);
    expect(engine.step(0.49)).toBe(1);
    expect(engine.step(0.5)).toBe(0);
  });

  it('uses the whole Length uniformly across unequal phase widths', () => {
    const engine = new PhasesDSP(1000, MULTI);
    engine.setLength(1);
    engine.trigger();
    advance(engine, 200);
    expect(engine.position).toBeCloseTo(0.2);
    expect(engine.value).toBeCloseTo(1);
    advance(engine, 500);
    expect(engine.position).toBeCloseTo(0.7);
    expect(engine.value).toBeCloseTo(0.4);
    advance(engine, 300);
    expect(engine.playing).toBe(false);
    expect(engine.position).toBe(1);
  });

  it('changes Length during playback without relocating the cursor or jumping the current sample', () => {
    const engine = ramp();
    engine.trigger();
    advance(engine, 200);
    const previous = engine.position;
    engine.setLength(2);
    expect(engine.position).toBe(previous);
    expect(engine.step()).toBeCloseTo(previous);
    expect(engine.position - previous).toBeCloseTo(0.0005);
    engine.setLength(0.05);
    const fastStart = engine.position;
    expect(engine.step()).toBeCloseTo(fastStart);
    expect(engine.position - fastStart).toBeCloseTo(0.02);
  });

  it('maps Length CV linearly, including patched zero, and restores the knob after unpatching', () => {
    expect(phasesLengthFromCv(0)).toBe(0.05);
    expect(phasesLengthFromCv(0.5)).toBeCloseTo(15.025);
    expect(phasesLengthFromCv(1)).toBe(30);
    expect(phasesLengthFromCv(-2)).toBe(0.05);
    expect(phasesLengthFromCv(2)).toBe(30);
    const engine = ramp(1000, 30);
    engine.trigger();
    engine.step(0, 0, 0, 0, 0);
    expect(engine.lengthCvPatched).toBe(true);
    expect(engine.effectiveLength).toBe(0.05);
    expect(engine.position).toBeCloseTo(0.02);
    engine.setLength(2);
    const position = engine.position;
    expect(engine.step(0, 0, 0, 0, 1)).toBeCloseTo(position);
    expect(engine.effectiveLength).toBe(30);
    expect(engine.position - position).toBeCloseTo(1 / 30000);
    const unplugged = engine.position;
    engine.step();
    expect(engine.lengthCvPatched).toBe(false);
    expect(engine.effectiveLength).toBe(2);
    expect(engine.position - unplugged).toBeCloseTo(0.0005);
  });

  it('changes polarity through the voltage mapping without modifying graph or cursor', () => {
    const engine = ramp();
    engine.trigger();
    advance(engine, 250);
    const vertices = engine.vertices;
    const position = engine.position;
    expect(engine.value).toBeCloseTo(0.25);
    engine.setPolarity(true);
    expect(engine.value).toBeCloseTo(-0.5);
    expect(engine.position).toBe(position);
    expect(engine.vertices).toBe(vertices);
    engine.trigger();
    expect(engine.value).toBe(-1);
    advance(engine, 1000);
    expect(engine.value).toBe(1);
  });

  it('reverses in place and a new Trigger starts at the right boundary', () => {
    const engine = ramp();
    engine.trigger();
    advance(engine, 400);
    const position = engine.position;
    engine.setReverse(true);
    expect(engine.position).toBe(position);
    expect(engine.step()).toBeCloseTo(position);
    expect(engine.position).toBeCloseTo(position - 0.001);
    engine.trigger();
    expect(engine.position).toBe(1);
    expect(engine.step()).toBe(1);
    advance(engine, 999);
    expect(engine.position).toBe(0);
    expect(engine.playing).toBe(false);
    engine.setReverse(false);
    expect(engine.playing).toBe(false);
  });

  it('Phase Trigger restarts the current phase in either direction, with full Trigger taking priority', () => {
    const engine = new PhasesDSP(1000, MULTI);
    engine.setLength(1);
    engine.trigger();
    advance(engine, 450);
    expect(engine.step(0, 1)).toBe(1);
    expect(engine.position).toBeCloseTo(0.201);
    advance(engine, 100);
    engine.setReverse(true);
    expect(engine.step(0, 1)).toBeCloseTo(0.4);
    expect(engine.position).toBeCloseTo(0.699);
    engine.step();
    expect(engine.step(1, 1)).toBe(0.8);
    expect(engine.position).toBeCloseTo(0.999);
  });

  it('Phase Trigger at a boundary stays at the current direction entry and can restart a completed phase', () => {
    const engine = new PhasesDSP(1000, MULTI);
    engine.setLength(1);
    engine.trigger();
    advance(engine, 200);
    engine.triggerPhase();
    expect(engine.position).toBe(0.2);
    engine.setReverse(true);
    engine.triggerPhase();
    expect(engine.position).toBe(0.2);
    advance(engine, 200);
    expect(engine.playing).toBe(false);
    engine.triggerPhase();
    expect(engine.position).toBe(0.2);
    expect(engine.playing).toBe(true);
  });

  it('Loop starts from idle, wraps, preserves an active cursor, and stops at the next boundary when disabled', () => {
    const engine = ramp(1000, 0.05);
    engine.setLoop(true);
    expect(engine.playing).toBe(true);
    advance(engine, 60);
    expect(engine.position).toBeCloseTo(0.2);
    const position = engine.position;
    engine.setLoop(false);
    expect(engine.position).toBe(position);
    advance(engine, 40);
    expect(engine.position).toBe(1);
    expect(engine.playing).toBe(false);
    engine.setLoop(true);
    expect(engine.position).toBe(0);
    expect(engine.playing).toBe(true);
  });

  it('preserves fractional sample overshoot when looping in either direction', () => {
    const engine = ramp(1000, 0.0755);
    engine.setLoop(true);
    advance(engine, 76);
    expect(engine.position).toBeCloseTo(76 / 75.5 - 1);
    const reverse = ramp(1000, 0.0755);
    reverse.setReverse(true);
    reverse.setLoop(true);
    expect(reverse.position).toBe(1);
    advance(reverse, 76);
    expect(reverse.position).toBeCloseTo(2 - 76 / 75.5);
  });

  it('Loop and Reverse are independent rising-edge toggles, not held-high repetition', () => {
    const engine = ramp();
    engine.step(1, 0, 1, 1);
    expect(engine.loop).toBe(true);
    expect(engine.reverse).toBe(true);
    expect(engine.position).toBeCloseTo(0.999);
    for (let i = 0; i < 100; i++) engine.step(1, 0, 1, 1);
    expect(engine.loop).toBe(true);
    expect(engine.reverse).toBe(true);
    expect(engine.position).toBeCloseTo(0.899);
    engine.step();
    engine.step(0, 0, 1, 1);
    expect(engine.loop).toBe(false);
    expect(engine.reverse).toBe(false);
  });

  it('editing vertices during playback preserves transport and never mutates caller data', () => {
    const engine = ramp();
    engine.trigger();
    advance(engine, 350);
    const position = engine.position;
    engine.setVertices(MULTI);
    expect(engine.position).toBe(position);
    expect(engine.playing).toBe(true);
    expect(engine.vertices).not.toBe(MULTI);
    expect(engine.value).toBeCloseTo(0.82);
  });
});
