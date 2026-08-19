// packages/web/src/lib/ui/modules/outlines-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for outlines' four readouts.
//
// Each readout exists because its knob's mapping is DISCONTINUOUS where the
// dial is not, so the control for each is the same shape: SAMPLE AT THE
// THRESHOLD, from both sides, and assert the two sides read differently. A
// readout tested only at 0.2 and 0.8 would pass while being wrong about the one
// value that matters.
//
// The instrument's own control is built in: every readout is also asserted to
// be INVARIANT to all six params it does not read. A formatter accidentally
// wired to the wrong key reads plausibly and would otherwise pass.

import { describe, it, expect } from 'vitest';
import {
  outlinesShapeText,
  outlinesSpinText,
  outlinesSpawnText,
  outlinesDecayText,
  OUTLINES_SHAPE_NAMES,
  OUTLINES_SIM_SHAPE_COUNT,
} from './outlines-face-model';
import { outlinesDef } from '$lib/video/modules/outlines';
import {
  RATE_ENGAGE_THRESHOLD,
  ROT_CENTER,
  mapAngularVel,
} from '$lib/video/modules/outlines-sim';

const DEFAULTS: Record<string, number> = Object.fromEntries(
  outlinesDef.params.map((p) => [p.id, p.defaultValue]),
);

function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined => (id in over ? over[id] : DEFAULTS[id]);
}
const emptyReader = (): number | undefined => undefined;

/** Every readout, so the invariance sweep below cannot forget one. */
const READOUTS: { id: string; reads: string; fn: (r: (id: string) => number | undefined) => string }[] = [
  { id: 'outlines-shape', reads: 'shape', fn: outlinesShapeText },
  { id: 'outlines-spin', reads: 'rotation', fn: outlinesSpinText },
  { id: 'outlines-spawn', reads: 'rate', fn: outlinesSpawnText },
  { id: 'outlines-decay', reads: 'decay', fn: outlinesDecayText },
];

describe('outlines readouts — sampled AT the discontinuity, which is why they exist', () => {
  it('the SPAWN clock: a thousandth of a knob turn is the difference between no clock and 3996 ms', () => {
    // `mapRateIntervalMs` returns null at or below the threshold. These two
    // dial positions are visually identical and are two different modules.
    expect(outlinesSpawnText(reader({ rate: RATE_ENGAGE_THRESHOLD }))).toBe('gate only');
    expect(outlinesSpawnText(reader({ rate: 0 }))).toBe('gate only');
    expect(outlinesSpawnText(reader({ rate: RATE_ENGAGE_THRESHOLD + 0.000001 }))).toBe('3996 ms');
    // …and the far end, plus the shipped default.
    expect(outlinesSpawnText(reader({ rate: 1 }))).toBe('500 ms');
    expect(outlinesSpawnText(reader({ rate: 0.5 }))).toBe('2250 ms');
  });

  it('DECAY: 0 is a MODE, and the default sits exactly on it', () => {
    // alphaFor(age, 0) is 1.0000 at every age (persist); 0.0001 is a 1 ms fade.
    // A face printing "0.0 s" here would be actively lying.
    expect(DEFAULTS.decay, 'the shipped default sits ON the discontinuity').toBe(0);
    expect(outlinesDecayText(reader())).toBe('persist');
    expect(outlinesDecayText(reader({ decay: 0 }))).toBe('persist');
    expect(outlinesDecayText(reader({ decay: 0.0001 }))).toBe('1 ms');
    expect(outlinesDecayText(reader({ decay: 1 }))).toBe('10.0 s');
    // It must never print a zero duration.
    for (const d of [0, 1e-9, 1e-12]) {
      expect(outlinesDecayText(reader({ decay: d })), `decay=${d}`).not.toMatch(/^0(\.0)? ?m?s$/);
    }
  });

  it('SHAPE: the band edges, where two visually identical dials are two shapes', () => {
    const band = 1 / OUTLINES_SIM_SHAPE_COUNT; // 0.166667
    expect(outlinesShapeText(reader({ shape: band - 1e-9 }))).toBe('CIRCLE');
    expect(outlinesShapeText(reader({ shape: band }))).toBe('TRI');
    expect(outlinesShapeText(reader({ shape: 1 }))).toBe('OCTA');
    expect(outlinesShapeText(reader({ shape: 0 }))).toBe('CIRCLE');
  });

  it('SPIN: it turns at EXACTLY centre and nowhere else — no deadband', () => {
    // ⚠ The CARD prints `·` across ±0.02, but mapAngularVel has no deadband: at
    // 0.52 the field turns a full revolution every 12.5 s. This readout asks
    // the sim, so it cannot disagree with the picture.
    expect(mapAngularVel(ROT_CENTER)).toBe(0);
    expect(outlinesSpinText(reader({ rotation: ROT_CENTER }))).toBe('still');
    expect(outlinesSpinText(reader({ rotation: ROT_CENTER + 0.02 }))).toBe('CW');
    expect(outlinesSpinText(reader({ rotation: ROT_CENTER - 0.02 }))).toBe('CCW');
    expect(outlinesSpinText(reader({ rotation: 1 }))).toBe('CW');
    expect(outlinesSpinText(reader({ rotation: 0 }))).toBe('CCW');
    // The measurement behind the correction, pinned so it cannot drift.
    expect(mapAngularVel(0.52)).toBeCloseTo(0.5027, 4);
  });

  // ── The instrument's own control: each readout reads ONE key ────────────
  it('every readout is INVARIANT to every param it does not read', () => {
    const wired: string[] = [];
    const ids = outlinesDef.params.map((p) => p.id);
    for (const ro of READOUTS) {
      const base = ro.fn(reader());
      for (const id of ids) {
        if (id === ro.reads) continue;
        for (const v of [0, 0.5, 1]) {
          if (ro.fn(reader({ [id]: v })) !== base) {
            wired.push(`${ro.id} moved on ${id}=${v} — it should only read ${ro.reads}`);
          }
        }
      }
    }
    expect(wired, 'readouts wired to the wrong param').toEqual([]);
  });

  it('every readout DOES move on the param it reads (positive control)', () => {
    const dead: string[] = [];
    for (const ro of READOUTS) {
      const seen = new Set([0, 0.2, 0.5, 0.8, 1].map((v) => ro.fn(reader({ [ro.reads]: v }))));
      if (seen.size < 2) dead.push(`${ro.id} is constant across its own param`);
    }
    expect(dead, 'readouts that cannot move at all').toEqual([]);
  });

  // ── Totality ────────────────────────────────────────────────────────────
  it('is TOTAL — a fresh node, NaN and ±Infinity all produce text, never a throw', () => {
    for (const ro of READOUTS) {
      expect(typeof ro.fn(emptyReader)).toBe('string');
      expect(ro.fn(emptyReader).length).toBeGreaterThan(0);
      for (const bad of [NaN, Infinity, -Infinity]) {
        const text = ro.fn(reader({ [ro.reads]: bad }));
        expect(typeof text, `${ro.id} at ${bad}`).toBe('string');
        expect(text, `${ro.id} at ${bad}`).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it('the shape-name list tracks the SIM, not a typed number', () => {
    // A seventh shape in the sim must not silently fall off the end of the
    // name list and print CIRCLE.
    expect(OUTLINES_SHAPE_NAMES.length).toBe(OUTLINES_SIM_SHAPE_COUNT);
  });
});

describe('outlines face declaration', () => {
  const face = outlinesDef.face!;

  it('ranks every USER param and no hidden one', () => {
    const hidden = new Set((outlinesDef.noUserControl ?? []).map((n) => n.param));
    for (const p of outlinesDef.params) {
      if (hidden.has(p.id)) {
        expect(face.order, `${p.id} is noUserControl and must NOT be ranked`).not.toContain(p.id);
      } else {
        expect(face.order, `${p.id} ranked`).toContain(p.id);
      }
    }
  });

  it('declares the two synthetic gate params as noUserControl, each with its port', () => {
    // Without this, module-face-lint's completeness loop demands an interactive
    // cell for each and the face paints two continuous rotaries over raw gate
    // levels.
    const declared = (outlinesDef.noUserControl ?? []).map((n) => n.param).sort();
    expect(declared).toEqual(['cv_collide', 'cv_gate']);
    for (const n of outlinesDef.noUserControl ?? []) {
      expect(n.writer).toBe('cv-port');
      expect(outlinesDef.inputs.some((i) => i.paramTarget === n.param), `${n.param} port`).toBe(true);
    }
  });

  it('routes its SCREEN toggle through the extension slot, not the card', () => {
    expect(face.extension).toBe('outlines');
  });
});
