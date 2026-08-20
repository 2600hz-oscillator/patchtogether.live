// packages/web/src/lib/ui/modules/b3ntb0x-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind b3ntb0x's two face readouts, plus the
// leg that keeps a REFUTED reading from quietly coming back.
//
// The `ripple gain` readout is the hard one to keep honest, because three
// different wrong formulas all look right from a single perturbation:
//
//   * a plain `enhance` readback moves when you turn ENHANCE — and is blind to
//     `sync_crush` and `bend_d`;
//   * an ADDITIVE combination moves with all three — and gets the value wrong
//     wherever both ENHANCE and BEND D are open, because the product carries a
//     `1.6·d·E` cross term (x5.40 vs x3.80 at both full);
//   * a "the bend stages interact, so everything does" formula moves with BIAS
//     — which is not in it at all.
//
// So the legs below pin the PRODUCT, the CROSS TERM, and the BIAS INVARIANCE
// separately. All three are needed; any two of them pass one of the wrong
// formulas above.
//
// The reference numbers come from a numeric replay of the bend shader's stages
// 2-4, which agreed with the closed form to 1.776e-15 over 972 points.

import { describe, expect, it } from 'vitest';
import { b3ntb0xDef } from '$lib/video/modules/b3ntb0x';
import {
  b3ntb0xFaceParams,
  b3ntb0xLineShift,
  b3ntb0xLineShiftText,
  b3ntb0xRippleGain,
  b3ntb0xRippleGainText,
} from './b3ntb0x-face-model';

function reader(patch: Readonly<Record<string, number>> = {}) {
  return (paramId: string): number | undefined => {
    if (paramId in patch) return patch[paramId];
    return b3ntb0xDef.params.find((p) => p.id === paramId)?.defaultValue;
  };
}
const P = (patch: Readonly<Record<string, number>> = {}) => b3ntb0xFaceParams(reader(patch));

/** The shader's own stages 2-4, replayed. The test's INSTRUMENT — kept here so
 *  the assertions below are checked against the pipeline rather than against
 *  the same closed form the model uses. */
function shaderRipple(E: number, S: number, B: number, d: number): number {
  const n = 0.17;
  const step = (vc0: number) => {
    let vc = vc0;
    vc = vc + (vc - n) * E * 2.0;
    vc = vc * S;
    vc = vc + B;
    if (Math.abs(d) > 1e-4) vc = vc + d * 0.8 * (vc - n);
    return vc;
  };
  const h = 1e-6;
  return (step(n + h) - step(n - h)) / (2 * h);
}

describe('b3ntb0x ripple gain: it agrees with the SHADER, not just with itself', () => {
  it('matches a numeric replay of the bend stages across the parameter space', () => {
    for (const E of [0, 0.25, 0.6, 1]) {
      for (const S of [0, 0.4, 1, 2]) {
        for (const B of [-1, 0, 0.5]) {
          for (const d of [-1, -0.3, 0.05, 0.5, 1]) {
            const model = b3ntb0xRippleGain({ enhance: E, sync_crush: S, bend_d: d, tbc: 1 });
            expect(
              model,
              `enhance=${E} sync_crush=${S} bias=${B} bend_d=${d}`,
            ).toBeCloseTo(shaderRipple(E, S, B, d), 9);
          }
        }
      }
    }
  });

  it('is x1.00 at the def defaults — the bend circuit is a wire until you turn something', () => {
    expect(b3ntb0xRippleGain(P())).toBeCloseTo(1, 12);
    expect(b3ntb0xRippleGainText(reader())).toBe('x1.00');
  });
});

describe('b3ntb0x ripple gain: THE NEGATIVE CONTROLS', () => {
  it('MOVES with all THREE params — the leg an `enhance` readback fails twice over', () => {
    const base = b3ntb0xRippleGain(P());
    expect(b3ntb0xRippleGain(P({ enhance: 1 }))).toBeGreaterThan(base);
    expect(b3ntb0xRippleGain(P({ sync_crush: 2 }))).toBeGreaterThan(base);
    expect(b3ntb0xRippleGain(P({ bend_d: 1 }))).toBeGreaterThan(base);
    // …and the two a dial-reader would never associate with "enhance" are on a
    // DIFFERENT PAGE of this very face (`bend_d` is on `taps`).
    expect(b3ntb0xRippleGain(P({ bend_d: 1 }))).toBeCloseTo(1.8, 12);
    expect(b3ntb0xRippleGain(P({ sync_crush: 2 }))).toBeCloseTo(2, 12);
  });

  it('carries the 1.6*d*E CROSS TERM — it is a PRODUCT, not a sum', () => {
    // ⚠ THE LEG THAT REFUSES AN ADDITIVE FORMULA. Both full is x5.40; two
    // independent controls contributing their own excess would give x3.80.
    const both = b3ntb0xRippleGain(P({ enhance: 1, bend_d: 1 }));
    expect(both).toBeCloseTo(5.4, 12);

    const neither = b3ntb0xRippleGain(P());
    const eOnly = b3ntb0xRippleGain(P({ enhance: 1 }));
    const dOnly = b3ntb0xRippleGain(P({ bend_d: 1 }));
    const additive = neither + (eOnly - neither) + (dOnly - neither);
    expect(additive).toBeCloseTo(3.8, 12);
    expect(both).not.toBeCloseTo(additive, 3);
  });

  it('is INVARIANT to BIAS — the leg that refuses "everything interacts"', () => {
    // `bias` is added AFTER the enhance stage and BEFORE bend D, so it shifts
    // the pedestal and contributes nothing to the ripple gain. A readout that
    // moved with it would be wrong in a way no single perturbation reveals.
    const base = b3ntb0xRippleGain(P());
    for (const b of [-1, -0.4, 0.3, 1]) {
      expect(b3ntb0xRippleGain(P({ bias: b })), `bias=${b}`).toBeCloseTo(base, 12);
    }
    // …with ENHANCE and BEND D open too, where a bias-sensitive formula would
    // be most tempting.
    const open = b3ntb0xRippleGain(P({ enhance: 1, bend_d: 1 }));
    expect(b3ntb0xRippleGain(P({ enhance: 1, bend_d: 1, bias: 1 }))).toBeCloseTo(open, 12);
  });

  it('is INVARIANT to every OTHER param on the module (the scope of the claim)', () => {
    const base = b3ntb0xRippleGain(P());
    const others = b3ntb0xDef.params
      .map((p) => p.id)
      .filter((id) => !['enhance', 'sync_crush', 'bend_d'].includes(id));
    for (const id of others) {
      const p = b3ntb0xDef.params.find((q) => q.id === id)!;
      expect(b3ntb0xRippleGain(P({ [id]: p.max })), `${id} must not move ripple gain`)
        .toBeCloseTo(base, 12);
    }
  });

  it('a NEGATIVE bend_d ATTENUATES rather than boosting — the signed form is deliberate', () => {
    // `(1 + 0.8d)` with d = -1 is 0.2. Using |d| here would print an
    // attenuating tap as a x1.80 boost.
    expect(b3ntb0xRippleGain(P({ bend_d: -1 }))).toBeCloseTo(0.2, 12);
    expect(b3ntb0xRippleGain(P({ bend_d: -1 }))).toBeLessThan(b3ntb0xRippleGain(P()));
  });

  it('honours the shader\'s own |d| <= 1e-4 stage guard', () => {
    // Below the guard the stage is not applied at all, so the gain is exactly
    // the no-tap value rather than 1 + 0.8*tiny.
    expect(b3ntb0xRippleGain(P({ bend_d: 1e-5 }))).toBe(b3ntb0xRippleGain(P({ bend_d: 0 })));
  });

  it('says `no signal` rather than `x0.00` when the master gain is shut', () => {
    expect(b3ntb0xRippleGainText(reader({ sync_crush: 0 }))).toBe('no signal');
  });
});

describe('b3ntb0x: ENHANCE and BEND D are TWO STAGES, not one (#1940 corrected)', () => {
  // ⚠ THIS BLOCK EXISTS SO A REFUTED READING CANNOT COME BACK. The claim was
  // that `bend_d` IS `enhance` under another name. They do share `neighborAvg`
  // and they do compound — but ENHANCE lands BEFORE the sync_crush multiply and
  // the bias add, BEND D after both, and that ordering is observable.
  const n = 0.17;
  function out(vc0: number, E: number, S: number, B: number, d: number): number {
    let vc = vc0;
    vc = vc + (vc - n) * E * 2.0;
    vc = vc * S;
    vc = vc + B;
    if (Math.abs(d) > 1e-4) vc = vc + d * 0.8 * (vc - n);
    return vc;
  }

  it('BEND D scales the BIAS term and ENHANCE does not touch it', () => {
    const dOutDb = (E: number, d: number) => (out(0.3, E, 1, 0.5, d) - out(0.3, E, 1, 0, d)) / 0.5;
    // bend_d multiplies bias by (1 + 0.8d)…
    expect(dOutDb(0, 0)).toBeCloseTo(1, 12);
    expect(dOutDb(0, 0.5)).toBeCloseTo(1.4, 12);
    expect(dOutDb(0, 1)).toBeCloseTo(1.8, 12);
    // …while enhance leaves it at 1 regardless.
    expect(dOutDb(1, 0)).toBeCloseTo(1, 12);
    expect(dOutDb(0.4, 0)).toBeCloseTo(1, 12);
  });

  it('BEND D moves the BASELINE coefficient only when sync_crush != 1', () => {
    // The n-coefficient is S + 0.8d(S-1): identical for d=0 and d=1 at S=1,
    // and genuinely different at S=0.5. ENHANCE never appears in it.
    const nCoeff = (S: number, d: number) => S + 0.8 * d * (S - 1);
    expect(nCoeff(1, 0)).toBeCloseTo(nCoeff(1, 1), 12);
    expect(nCoeff(0.5, 0)).toBeCloseTo(0.5, 12);
    expect(nCoeff(0.5, 1)).toBeCloseTo(0.1, 12);
  });

  it('both params still EXIST on the def — neither was deleted on the refuted reading', () => {
    for (const id of ['enhance', 'bend_d']) {
      expect(b3ntb0xDef.params.some((p) => p.id === id), `${id} must still be a control`).toBe(true);
    }
  });
});

describe('b3ntb0x line shift: the readout that states #1946', () => {
  it('reads `locked` at the SHIPPED DEFAULT, because the answer is exactly zero', () => {
    expect(b3ntb0xDef.params.find((p) => p.id === 'tbc')!.defaultValue).toBe(1);
    expect(b3ntb0xLineShift(P())).toBe(0);
    expect(b3ntb0xLineShiftText(reader())).toBe('locked');
  });

  it('is `locked` NO MATTER how hard the sync tip is crushed — the defect, stated', () => {
    // The module's own docs say "Crank Sync Crush + Bias to tear and roll".
    // At the default tbc these move the readout not at all, which is the
    // honest surface-level statement of #1946.
    expect(b3ntb0xLineShiftText(reader({ sync_crush: 2, bias: 1 }))).toBe('locked');
    expect(b3ntb0xLineShiftText(reader({ sync_crush: 0, bias: -1 }))).toBe('locked');
  });

  it('opens up as TBC comes down, and is INVARIANT to everything else', () => {
    expect(b3ntb0xLineShiftText(reader({ tbc: 0 }))).toBe('100%');
    expect(b3ntb0xLineShiftText(reader({ tbc: 0.25 }))).toBe('75%');
    const others = b3ntb0xDef.params.map((p) => p.id).filter((id) => id !== 'tbc');
    for (const id of others) {
      const p = b3ntb0xDef.params.find((q) => q.id === id)!;
      expect(b3ntb0xLineShiftText(reader({ tbc: 0.5, [id]: p.max })), `${id}`).toBe('50%');
    }
  });
});

describe('b3ntb0x readouts: TOTALITY (they run on every render)', () => {
  it('a FRESH node returns strings and never throws', () => {
    const blank = () => undefined;
    expect(() => b3ntb0xRippleGainText(blank)).not.toThrow();
    expect(() => b3ntb0xLineShiftText(blank)).not.toThrow();
    expect(b3ntb0xRippleGainText(blank)).toBe('x1.00');
    expect(b3ntb0xLineShiftText(blank)).toBe('locked');
  });

  it('NaN and +/-Infinity fall back to the declared defaults, and never print NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['enhance', 'sync_crush', 'bend_d', 'tbc']) {
        const r = reader({ [id]: bad });
        for (const f of [b3ntb0xRippleGainText, b3ntb0xLineShiftText]) {
          const s = f(r);
          expect(s, `${id}=${bad}`).not.toContain('NaN');
          expect(s).not.toContain('Infinity');
        }
      }
    }
  });

  it('an OUT-OF-CONTRACT write is clamped to the declared travel', () => {
    expect(P({ sync_crush: 999 }).sync_crush).toBe(2);
    expect(P({ bend_d: -50 }).bend_d).toBe(-1);
    expect(P({ tbc: 4 }).tbc).toBe(1);
  });
});

describe('b3ntb0x face: the declaration', () => {
  // ── THE RESTING-TEXT CASES ARE GONE: THE TYPE ENFORCES THEM NOW ───────────
  //
  // This block used to carry `it('declares NO hero readouts …')`, asserting
  // `face.hero.readouts` was empty. #1971 deleted the `readouts` FIELD from
  // `ModuleFaceHero` outright, so that expression no longer typechecks — and
  // the assertion behind it is now made by `tsc`, for every module, before a
  // test runs. `graph/types.ts` states it at the declaration site: *"THERE IS
  // NO `readouts` FIELD … re-adding either — under any name — is the mistake
  // this note exists to prevent."*
  //
  // ⚠ THIS IS A DELETION, NOT A COVERAGE LAPSE, and the direction matters: a
  // per-module runtime check that a field is empty is strictly WEAKER than a
  // type that refuses the field. The fleet-wide SHAPE is denied by
  // `face-resting-text-source.test.ts`, which enumerates the permitted text
  // roles and reddens on the TYPE — the formulation chosen precisely because
  // four different mechanisms had each passed the gate written for the
  // previous one.
  //
  // What b3ntb0x specifically lost a SURFACE for is recorded rather than left
  // to lapse: `ripple gain` = `sync_crush · (1 + 2·enhance) · (1 + 0.8·bend_d)`
  // is a JOIN across three params on two pages, so unlike a single-param value
  // it has no host control whose `aria-valuetext` could carry it — it is
  // removed from the product, not relocated. The arithmetic and the derivation
  // that refutes #1940's "bend_d IS enhance" reading both survive above, in
  // this file's own model cases.

  // ── THE REGISTRY CHECK AND ITS POSITIVE CONTROL ARE GONE, ON THE CONTROL'S
  //    OWN INSTRUCTION ─────────────────────────────────────────────────────
  //
  // This file used to carry two more cases: "registers no readout VALUE either
  // — deleted, not hidden" (asserting `faceReadoutValueFor` returned falsy for
  // `b3ntb0x-ripple-gain` / `b3ntb0x-line-shift`) and a positive control
  // proving that lookup could still say YES for some OTHER face. The control
  // named its own exit condition: *"either the fleet-wide removal is complete
  // (in which case delete this control and the two checks with it) or the
  // registry did not build."*
  //
  // #1971 completed the fleet-wide removal — `face-readout-values.ts` and every
  // id in it are DELETED, so `faceReadoutValueIds()` has no first element and
  // the disjunction resolves to its first branch. Both cases go, together, as
  // the control instructed. Keeping the negative half alone was the one
  // outcome it explicitly ruled out: with the registry gone it would pass for
  // EVERY id ever written and report that as compliance.
  //
  // Nothing is left uncovered. The registry is no longer a thing a face can
  // register into, and the SHAPE is now denied fleet-wide at the type level by
  // `face-resting-text-source.test.ts` — RED before a module adopts it, which
  // is strictly stronger than this module asserting its own absence.

  it('ranks TBC into the same tier as the pair it gates (#1946)', () => {
    const order = b3ntb0xDef.face?.order ?? [];
    const at = (id: string) => order.indexOf(id);
    expect(at('tbc')).toBeGreaterThanOrEqual(0);
    // The plate tier is the widest lane tier at 6 cells; sync_crush, bias and
    // the control that PERMITS their documented effect must all be inside it.
    expect(at('sync_crush')).toBeLessThan(6);
    expect(at('bias')).toBeLessThan(6);
    expect(at('tbc')).toBeLessThan(6);
  });

  it('ranks ENHANCE and BEND D adjacent, so no tier hides their interaction', () => {
    const order = b3ntb0xDef.face?.order ?? [];
    expect(Math.abs(order.indexOf('enhance') - order.indexOf('bend_d'))).toBe(1);
  });

  it('declares SIX pages — under the tab rail, with no page padded to reach it', () => {
    const pages = b3ntb0xDef.face?.pages ?? [];
    expect(pages.length).toBe(6);
    // No one-control page: the honest grouping earns every header it takes.
    for (const p of pages) {
      expect(p.controls.length, `page '${p.id}' must earn its header`).toBeGreaterThanOrEqual(2);
    }
  });

  it('pages partition the ranked roster exactly — no control unpaged or twice', () => {
    const order = b3ntb0xDef.face?.order ?? [];
    const paged = (b3ntb0xDef.face?.pages ?? []).flatMap((p) => [...p.controls]);
    expect([...paged].sort()).toEqual([...order].sort());
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('the THREE params a player never sets are declared noUserControl, not ranked', () => {
    // Two synthetic CV-bridge levels plus the VRT determinism toggle. Painting
    // any of them would put a rotary over a voltage nobody sets by hand — and
    // for `freeze`, a control that stops the module rendering.
    const order = b3ntb0xDef.face?.order ?? [];
    const declared = (b3ntb0xDef.noUserControl ?? []).map((n) => n.param).sort();
    expect(declared).toEqual(['freeze', 'mirrorXGate', 'mirrorYGate']);
    for (const id of declared) expect(order).not.toContain(id);
    // Each names a REAL param and states who writes it instead.
    for (const n of b3ntb0xDef.noUserControl ?? []) {
      expect(b3ntb0xDef.params.some((p) => p.id === n.param), n.param).toBe(true);
      expect(n.why.length, `${n.param} needs an argument`).toBeGreaterThan(40);
    }
    expect((b3ntb0xDef.noUserControl ?? []).find((n) => n.param === 'freeze')?.writer)
      .toBe('internal');
  });

  it('the freeze param exists and rests OFF, so nothing is frozen in production', () => {
    // ⚠ The scene-settle mechanism, and the reason the first VRT dispatch of
    // this face timed out at 90 s and committed zero baselines: the harness
    // writes `params.freeze`, and this module previously had only a globalThis
    // time-pin the harness never sets (#1941).
    const p = b3ntb0xDef.params.find((q) => q.id === 'freeze');
    expect(p, 'freeze must be a ParamDef — the harness writes it through the graph').toBeTruthy();
    expect(p!.defaultValue).toBe(0);
    expect(p!.min).toBe(0);
    expect(p!.max).toBe(1);
  });

  it('mirrorX / mirrorY are DISCRETE, so the face paints toggles and not rotaries', () => {
    for (const id of ['mirrorX', 'mirrorY']) {
      const p = b3ntb0xDef.params.find((q) => q.id === id)!;
      expect(p.curve, `${id} must be switch-shaped`).toBe('discrete');
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
    }
  });
});
