// packages/web/src/lib/ui/modules/treeohvox-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the TREE.oh.VOX sweep readouts.
//
// WHAT MAKES THIS FILE NECESSARY: the nearest knob to all three readouts is
// CUTOFF, it moves when you turn CUTOFF, and it is WRONG — the filter is never
// at the dial's frequency. Worse, it is blind to ENVMOD, which moves the peak
// by 6.6× on its own. A reviewer checking "does it move when I turn the cutoff
// knob" gets a green on a readout that could be a plain `cutoff` readback.
//
// So the discriminating legs are the ones that hold CUTOFF STILL.

import { describe, expect, it } from 'vitest';
import { treeohvoxDef } from '$lib/audio/modules/treeohvox';
import {
  treeohvoxAccentPeakHz,
  treeohvoxAccentPeakText,
  treeohvoxFaceParams,
  treeohvoxPeakHz,
  treeohvoxPeakText,
  treeohvoxRestHz,
  treeohvoxRestText,
} from './treeohvox-face-model';

function reader(patch: Readonly<Record<string, number>> = {}) {
  return (paramId: string): number | undefined => {
    if (paramId in patch) return patch[paramId];
    return treeohvoxDef.params.find((p) => p.id === paramId)?.defaultValue;
  };
}

const P = (patch: Readonly<Record<string, number>> = {}) => treeohvoxFaceParams(reader(patch));

describe('treeohvox sweep readouts: the DEFAULTS, and what the dial claims instead', () => {
  it('the def still ships the defaults these figures were measured at', () => {
    // Anchors every number below to the artifact; a default change reddens here
    // first rather than silently invalidating the comments.
    const byId = (id: string) => treeohvoxDef.params.find((p) => p.id === id)!;
    expect(byId('cutoff').defaultValue).toBe(1000);
    expect(byId('envelope').defaultValue).toBe(0.5);
    expect(byId('accent').defaultValue).toBe(0.5);
  });

  it('THE CUTOFF DIAL PRINTS A FREQUENCY THE FILTER IS NEVER AT', () => {
    const p = P();
    expect(treeohvoxRestHz(p)).toBeCloseTo(533.389, 2);
    expect(treeohvoxPeakHz(p)).toBeCloseTo(3757.566, 2);
    expect(treeohvoxAccentPeakHz(p)).toBeCloseTo(5314.001, 2);
    // …against a dial reading 1000. The knob's number is strictly between rest
    // and peak and equals neither, which is the whole reason these exist.
    expect(treeohvoxRestHz(p)).toBeLessThan(1000);
    expect(treeohvoxPeakHz(p)).toBeGreaterThan(1000);
  });

  it('formats as the face prints them', () => {
    expect(treeohvoxRestText(reader())).toBe('533 Hz');
    expect(treeohvoxPeakText(reader())).toBe('3.76 kHz');
    expect(treeohvoxAccentPeakText(reader())).toBe('5.31 kHz');
  });
});

describe('treeohvox sweep readouts: THE NEGATIVE CONTROLS (cutoff held STILL)', () => {
  it('ENVMOD moves the peak 6.6x while the CUTOFF DIAL DOES NOT MOVE AT ALL', () => {
    // The leg a `cutoff` readback fails outright: it is invariant to envelope.
    const peaks = [0, 0.25, 0.5, 0.75, 1].map((e) => treeohvoxPeakHz(P({ envelope: e })));
    expect(peaks[0]).toBeCloseTo(1463.0, 1);
    expect(peaks[4]).toBeCloseTo(9650.6, 1);
    // Strictly increasing — not merely "different".
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeGreaterThan(peaks[i - 1]!);
    expect(peaks[4]! / peaks[0]!).toBeGreaterThan(6);
    // …and the knob a reviewer would perturb is bit-identical across all five.
    for (const e of [0, 0.25, 0.5, 0.75, 1]) expect(P({ envelope: e }).cutoff).toBe(1000);
  });

  it('REST MOVES THE OPPOSITE WAY over that same sweep — the leg that proves two numbers, not one', () => {
    // ⚠ THIS IS THE STRONGEST ASSERTION IN THE FILE. A readout that was `peak`
    // rescaled — or `cutoff` rescaled — would move rest and peak the SAME
    // direction. They diverge: raising ENVMOD widens the sweep from BOTH ends.
    const rests = [0, 0.25, 0.5, 0.75, 1].map((e) => treeohvoxRestHz(P({ envelope: e })));
    expect(rests[0]).toBeCloseTo(834.7, 1);
    expect(rests[4]).toBeCloseTo(340.8, 1);
    for (let i = 1; i < rests.length; i++) expect(rests[i]).toBeLessThan(rests[i - 1]!);
  });

  it('ACCENT moves ONLY the accented peak — the other two are invariant to it', () => {
    const base = P();
    for (const a of [0, 0.5, 1]) {
      const p = P({ accent: a });
      expect(treeohvoxRestHz(p), 'rest must not see ACCENT').toBeCloseTo(treeohvoxRestHz(base), 9);
      expect(treeohvoxPeakHz(p), 'the plain peak must not see ACCENT').toBeCloseTo(
        treeohvoxPeakHz(base),
        9,
      );
    }
    // …while the accented peak does, monotonically.
    expect(treeohvoxAccentPeakHz(P({ accent: 0 }))).toBeCloseTo(3757.566, 2);
    expect(treeohvoxAccentPeakHz(P({ accent: 1 }))).toBeCloseTo(7515.132, 2);
    // At accent 0 the accented peak IS the plain peak — the seam is continuous.
    expect(treeohvoxAccentPeakHz(P({ accent: 0 }))).toBeCloseTo(treeohvoxPeakHz(P()), 9);
  });

  it('CUTOFF does move them — the POSITIVE control, so a dead formula cannot pass', () => {
    // Without this, a function that returned constants would satisfy the
    // invariance legs above.
    expect(treeohvoxPeakHz(P({ cutoff: 2000 }))).toBeGreaterThan(treeohvoxPeakHz(P()));
    expect(treeohvoxRestHz(P({ cutoff: 2000 }))).toBeGreaterThan(treeohvoxRestHz(P()));
  });
});

describe('treeohvox sweep readouts: the CLAMPS the voice actually applies', () => {
  it('the peak is held at the FILTER ceiling, which is far above the knob max', () => {
    // `updateFilter` clamps instCutoff to 20 kHz — NOT to the def's 6000 Hz
    // knob max, which bounds only where the sweep STARTS. Measured: at cutoff
    // 1000 with envelope and accent at full the peak is 19301.3 Hz (unclamped),
    // and at cutoff 2000 it saturates.
    expect(treeohvoxAccentPeakHz(P({ cutoff: 1000, envelope: 1, accent: 1 }))).toBeCloseTo(
      19301.3,
      1,
    );
    expect(treeohvoxAccentPeakHz(P({ cutoff: 2000, envelope: 1, accent: 1 }))).toBe(20000);
    expect(treeohvoxAccentPeakHz(P({ cutoff: 6000, envelope: 1, accent: 1 }))).toBe(20000);
  });

  it('the rest floor is the ladder floor, and it bites at low cutoff with high ENVMOD', () => {
    expect(treeohvoxRestHz(P({ cutoff: 100, envelope: 1 }))).toBe(40);
    expect(treeohvoxRestHz(P({ cutoff: 1000, envelope: 1 }))).toBeCloseTo(340.84, 2);
  });
});

describe('treeohvox sweep readouts: TOTALITY (they run on every render)', () => {
  it('a FRESH node — a reader that knows nothing — returns strings, never throws', () => {
    const blank = () => undefined;
    for (const f of [treeohvoxRestText, treeohvoxPeakText, treeohvoxAccentPeakText]) {
      expect(() => f(blank)).not.toThrow();
      expect(typeof f(blank)).toBe('string');
    }
    // …and they are the DEFAULT figures, since a blank reader falls back to them.
    expect(treeohvoxRestText(blank)).toBe('533 Hz');
  });

  it('NaN and ±Infinity fall back to the DECLARED defaults, and never print NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['cutoff', 'envelope', 'accent']) {
        const r = reader({ [id]: bad });
        for (const f of [treeohvoxRestText, treeohvoxPeakText, treeohvoxAccentPeakText]) {
          const s = f(r);
          expect(s, `${id}=${bad}`).not.toContain('NaN');
          expect(s).not.toContain('Infinity');
        }
      }
    }
  });

  it('an OUT-OF-CONTRACT write is clamped to the declared travel', () => {
    // The MIDI-learn / automation / preset-load seam.
    expect(P({ cutoff: 99999 }).cutoff).toBe(6000);
    expect(P({ cutoff: -5 }).cutoff).toBe(40);
    expect(P({ envelope: 12 }).envelope).toBe(1);
    expect(P({ accent: -3 }).accent).toBe(0);
  });
});

describe('treeohvox face: the AUDITION the def ordered', () => {
  it('ranks the gate cell INSIDE the compact lane budget, not below it', () => {
    // #1658's lesson: this voice is bit-silent unpatched, so a lane tier full
    // of timbre controls with no way to sound them is the sixstrum defect.
    const order = treeohvoxDef.face?.order ?? [];
    const gateRank = order.indexOf('treeohvox-gate-{n}');
    expect(gateRank, 'the gate cell must be ranked at all').toBeGreaterThanOrEqual(0);
    // Rank 3 (index 2) — within LANE_ROW_MAX_CELLS even in the WITH-GLYPH case
    // is 2, so this is the first rank the plate tier guarantees; assert it is
    // comfortably inside the 6-cell plate rather than pinning the exact cap.
    expect(gateRank).toBeLessThan(6);
  });

  it('ranks ACCENT below every lane budget — it is inert on the audition surface', () => {
    // MEASURED, not preferred: the audition ConstantSource is connected to
    // worklet input 1 (`gate_in`) alone, so an auditioned note is never
    // accented. The plate tier is the widest lane tier at 6 cells.
    const order = treeohvoxDef.face?.order ?? [];
    expect(order.indexOf('accent')).toBeGreaterThanOrEqual(6);
  });

  it('every page control is ranked, and the pages partition the roster exactly', () => {
    const order = treeohvoxDef.face?.order ?? [];
    const paged = (treeohvoxDef.face?.pages ?? []).flatMap((p) => [...p.controls]);
    expect([...paged].sort()).toEqual([...order].sort());
    expect(new Set(paged).size).toBe(paged.length);
  });
});
