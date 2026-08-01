// packages/web/src/lib/audio/dx7-op-role.test.ts

import { describe, it, expect } from 'vitest';
import { DX7_ALGORITHMS } from './dx7-algorithms';
import { dx7OpRole, dx7OpRoles, dx7RoleFallbackColor } from './dx7-op-role';

/** c = carrier, m = modulator, b = both — one letter per operator, op1 first. */
const ROLE_GOLDEN: Record<number, string> = {
  1: 'cmcmmm',  2: 'cmcmmm',  3: 'cmmcmm',  4: 'cmmbmm',
  5: 'cmcmcm',  6: 'cmcmbm',  7: 'cmcmmm',  8: 'cmcmmm',
  9: 'cmcmmm', 10: 'cmmcmm', 11: 'cmmcmm', 12: 'cmcmmm',
  13: 'cmcmmm', 14: 'cmcmmm', 15: 'cmcmmm', 16: 'cmmmmm',
  17: 'cmmmmm', 18: 'cmmmmm', 19: 'cmmccm', 20: 'ccmcmm',
  21: 'ccmccm', 22: 'cmcccm', 23: 'ccmccm', 24: 'cccccm',
  25: 'cccccm', 26: 'ccmcmm', 27: 'ccmcmm', 28: 'cmcmmc',
  29: 'cccmcm', 30: 'cccmmc', 31: 'cccccm', 32: 'cccccc',
};

const letters = (num: number) => dx7OpRoles(num)!.map((r) => r.role[0]).join('');

describe('dx7OpRole', () => {
  it('pins every operator role for all 32 algorithms', () => {
    for (let n = 1; n <= 32; n++) expect(letters(n), `alg ${n}`).toBe(ROLE_GOLDEN[n]);
  });

  it('agrees with the routing table on who is a carrier', () => {
    for (const algo of DX7_ALGORITHMS) {
      for (let op = 0; op < 6; op++) {
        const info = dx7OpRole(algo.num, op)!;
        expect(info.onCarrierRail).toBe(algo.carriers.includes(op));
        // The rail is the accessible cue: it must be true for BOTH as well as
        // for a plain carrier, or a dual-role operator vanishes from the sum.
        expect(info.onCarrierRail).toBe(info.role === 'carrier' || info.role === 'both');
      }
    }
  });

  it('marks the feedback endpoints from the table', () => {
    for (const algo of DX7_ALGORITHMS) {
      for (let op = 0; op < 6; op++) {
        const info = dx7OpRole(algo.num, op)!;
        expect(info.feedbackSource).toBe(algo.feedback.from === op);
        expect(info.feedbackTarget).toBe(algo.feedback.to === op);
      }
    }
  });

  it('calls exactly TWO cells "both" — algorithm 4 op4 and algorithm 6 op5', () => {
    // The two MULTI-OPERATOR feedback loops: a carrier whose output also bends
    // another operator's phase. Pinning the COUNT is the guard against the
    // definition quietly widening (e.g. counting self-loops, which would make
    // alg 32's op6 "both" and repaint a third of the chart).
    const both: string[] = [];
    for (let n = 1; n <= 32; n++) {
      dx7OpRoles(n)!.forEach((r) => { if (r.role === 'both') both.push(`${n}:op${r.op + 1}`); });
    }
    expect(both).toEqual(['4:op4', '6:op5']);
  });

  it('does NOT treat a self-loop as a second job', () => {
    // Algorithm 32 is six carriers with a self-loop on op6. A self-loop is an
    // operator re-entering its own phase, not modulation of another operator.
    const op6 = dx7OpRole(32, 5)!;
    expect(op6.feedbackSource).toBe(true);
    expect(op6.feedbackTarget).toBe(true);
    expect(op6.role).toBe('carrier');
  });

  it('gives every role a distinct themable colour token with a literal fallback', () => {
    const seen = new Set<string>();
    for (const role of ['carrier', 'modulator', 'both'] as const) {
      const color = dx7RoleFallbackColor(role);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      seen.add(color);
    }
    expect(seen.size).toBe(3);
    const info = dx7OpRole(1, 0)!;
    expect(info.colorVar).toBe('--dx7-op-carrier');
    expect(info.colorToken).toBe(`var(--dx7-op-carrier, ${dx7RoleFallbackColor('carrier')})`);
  });

  it('returns undefined for a bad algorithm or operator index rather than throwing', () => {
    expect(dx7OpRole(0, 0)).toBeUndefined();
    expect(dx7OpRole(33, 0)).toBeUndefined();
    expect(dx7OpRole(1.5, 0)).toBeUndefined();
    expect(dx7OpRole(1, -1)).toBeUndefined();
    expect(dx7OpRole(1, 6)).toBeUndefined();
    expect(dx7OpRole(1, 1.5)).toBeUndefined();
    expect(dx7OpRoles(0)).toBeUndefined();
  });
});

describe('dx7OpRole — negative controls', () => {
  it('every algorithm has at least one carrier and the count varies as the chart says', () => {
    const counts = new Map<number, number[]>();
    for (let n = 1; n <= 32; n++) {
      const c = dx7OpRoles(n)!.filter((r) => r.onCarrierRail).length;
      expect(c).toBeGreaterThanOrEqual(1);
      if (!counts.has(c)) counts.set(c, []);
      counts.get(c)!.push(n);
    }
    // 1 carrier (deep stacks) through 6 (fully additive) must all be reachable
    // — a role function that returned a constant would collapse this.
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(counts.get(6)).toEqual([32]);
    expect(counts.get(1)).toEqual([16, 17, 18]);
  });

  it('the role string differs between algorithms with different carrier sets', () => {
    // alg 5 (3 carriers) vs alg 16 (1) vs alg 32 (6) — three distinct strings.
    expect(new Set([letters(5), letters(16), letters(32)]).size).toBe(3);
  });
});
