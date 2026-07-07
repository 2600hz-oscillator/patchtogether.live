// packages/web/src/lib/audio/modules/analog-logic-maths.test.ts
//
// Unit tests for ANALOGLOGICMATHS pure helpers + module-def shape. Worklet
// rendering is covered by the ART harness next door.

import { describe, expect, it } from 'vitest';
import { analogLogicMath } from './analog-logic-maths';

describe('analogLogicMath: attenuverter', () => {
  it('atten=+1 is identity', () => {
    for (const x of [-1, -0.5, 0, 0.25, 1]) {
      expect(analogLogicMath.atten(x, 1)).toBeCloseTo(x, 12);
    }
  });

  it('atten=0 mutes input', () => {
    // Use Math.abs to fold -0 → +0 for the equality check; the JS multiply
    // x * 0 returns -0 for negative x, which Object.is treats as distinct.
    // Semantically both are "zero".
    expect(Math.abs(analogLogicMath.atten(0.7, 0))).toBe(0);
    expect(Math.abs(analogLogicMath.atten(-1, 0))).toBe(0);
  });

  it('atten=-1 inverts', () => {
    expect(analogLogicMath.atten(0.5, -1)).toBeCloseTo(-0.5, 12);
    expect(analogLogicMath.atten(-0.3, -1)).toBeCloseTo(0.3, 12);
  });

  it('atten=0.5 halves', () => {
    expect(analogLogicMath.atten(1, 0.5)).toBeCloseTo(0.5, 12);
    expect(analogLogicMath.atten(-0.4, 0.5)).toBeCloseTo(-0.2, 12);
  });
});

describe('analogLogicMath: min', () => {
  it('min(1, 0) = 0', () => {
    expect(analogLogicMath.min(1, 0)).toBe(0);
  });
  it('min(-0.5, 0.5) = -0.5', () => {
    expect(analogLogicMath.min(-0.5, 0.5)).toBe(-0.5);
  });
  it('min is commutative', () => {
    for (const [a, b] of [[0.3, 0.7], [-0.2, 0.4], [-0.9, -0.1]] as Array<[number, number]>) {
      expect(analogLogicMath.min(a, b)).toBe(analogLogicMath.min(b, a));
    }
  });
});

describe('analogLogicMath: max', () => {
  it('max(0.5, 0.3) = 0.5', () => {
    expect(analogLogicMath.max(0.5, 0.3)).toBe(0.5);
  });
  it('max(-0.5, 0.5) = 0.5', () => {
    expect(analogLogicMath.max(-0.5, 0.5)).toBe(0.5);
  });
  it('max is commutative', () => {
    for (const [a, b] of [[0.3, 0.7], [-0.2, 0.4], [-0.9, -0.1]] as Array<[number, number]>) {
      expect(analogLogicMath.max(a, b)).toBe(analogLogicMath.max(b, a));
    }
  });
});

describe('analogLogicMath: diff', () => {
  it('diff(1, 0.5) = 0.5', () => {
    expect(analogLogicMath.diff(1, 0.5)).toBeCloseTo(0.5, 12);
  });
  it('diff(-0.3, 0.4) = -0.7', () => {
    expect(analogLogicMath.diff(-0.3, 0.4)).toBeCloseTo(-0.7, 12);
  });
  it('diff is anti-symmetric', () => {
    for (const [a, b] of [[0.3, 0.7], [-0.2, 0.4]] as Array<[number, number]>) {
      expect(analogLogicMath.diff(a, b)).toBeCloseTo(-analogLogicMath.diff(b, a), 12);
    }
  });
});

describe('analogLogicMath: sum (with tanh soft-clip)', () => {
  it('sum(0, 0) = 0', () => {
    expect(analogLogicMath.sum(0, 0)).toBe(0);
  });
  it('small sums pass through nearly transparent (tanh(x) ≈ x)', () => {
    // tanh(0.2) ≈ 0.197, well within 0.01 of the linear sum.
    expect(analogLogicMath.sum(0.1, 0.1)).toBeCloseTo(Math.tanh(0.2), 12);
    expect(Math.abs(analogLogicMath.sum(0.1, 0.1) - 0.2)).toBeLessThan(0.01);
  });
  it('soft-clip engages above unity (|out| < 1 for any input)', () => {
    // a + b = 2 → tanh(2) ≈ 0.964, well under 1.
    expect(analogLogicMath.sum(1, 1)).toBeLessThan(1);
    expect(analogLogicMath.sum(1, 1)).toBeGreaterThan(0.9);
    // Extreme — tanh(10) ≈ 1.0 but strictly less.
    expect(analogLogicMath.sum(5, 5)).toBeLessThan(1);
    expect(analogLogicMath.sum(-5, -5)).toBeGreaterThan(-1);
  });
});

describe('analogLogicMath: product (with tanh soft-clip)', () => {
  it('product(0.5, 0.5) = tanh(0.25) ≈ 0.245', () => {
    // tanh(0.25) ≈ 0.2449, close to the raw 0.25 product.
    expect(analogLogicMath.product(0.5, 0.5)).toBeCloseTo(Math.tanh(0.25), 12);
  });
  it('product(0, x) = 0 for any x', () => {
    for (const x of [-1, -0.3, 0.7, 1]) {
      // Use Math.abs to fold -0 → +0 (Object.is treats them as distinct;
      // tanh(0 * neg) returns -0). Semantically both are "zero".
      expect(Math.abs(analogLogicMath.product(0, x))).toBe(0);
    }
  });
  it('soft-clip engages on large products', () => {
    // 2 * 2 = 4 → tanh(4) ≈ 0.9993
    expect(analogLogicMath.product(2, 2)).toBeLessThan(1);
    expect(analogLogicMath.product(2, 2)).toBeGreaterThan(0.99);
  });
  it('product preserves sign', () => {
    expect(analogLogicMath.product(0.5, -0.5)).toBeLessThan(0);
    expect(analogLogicMath.product(-0.5, -0.5)).toBeGreaterThan(0);
  });
});

describe('analogLogicMath: attenuverter applies before the math', () => {
  // The worklet computes a' = a*attA, b' = b*attB, then runs the math on
  // a' and b'. These tests pin that ordering through the helpers.
  it('attA=-1 inverts A, then DIFF reverses sign', () => {
    // a=0.5 attA=-1 → a' = -0.5. b=0.5 attB=+1 → b' = 0.5.
    // diff = a' - b' = -1.0
    const aPrime = analogLogicMath.atten(0.5, -1);
    const bPrime = analogLogicMath.atten(0.5, 1);
    expect(analogLogicMath.diff(aPrime, bPrime)).toBeCloseTo(-1, 12);
  });
  it('attB=0 mutes B → SUM = tanh(A) for tiny A', () => {
    const aPrime = analogLogicMath.atten(0.1, 1);
    const bPrime = analogLogicMath.atten(0.5, 0);
    expect(analogLogicMath.sum(aPrime, bPrime)).toBeCloseTo(Math.tanh(0.1), 12);
  });
});
