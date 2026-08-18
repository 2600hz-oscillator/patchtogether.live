// packages/web/src/lib/ui/controls/param-format.test.ts
//
// The ONE readout ladder + the SOURCE-LEVEL guard that keeps it one.
//
// The ladder itself is trivially testable. The interesting half is the second
// describe: no runtime gate can see a Svelte component quietly re-declaring a
// private `format(v, u)` — the strings only differ on some values, on some
// params, in some components, which is precisely the class of divergence that
// hides for months. So it is checked at the SOURCE level (the
// `controlFamilies` → card-testid grep in module-docs-lint.test.ts is the
// existing precedent for this shape of gate).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatParamNumber, isBipolarRange } from './param-format';

describe('formatParamNumber — the shared readout ladder', () => {
  it('steps precision down as magnitude grows, with a k suffix past 1000', () => {
    expect(formatParamNumber(0.35)).toBe('0.35');
    expect(formatParamNumber(9.994)).toBe('9.99');
    expect(formatParamNumber(12.54)).toBe('12.5');
    expect(formatParamNumber(440)).toBe('440');
    expect(formatParamNumber(1500)).toBe('1.50k');
    expect(formatParamNumber(20000)).toBe('20.0k');
  });

  it('switches rung on ABSOLUTE magnitude, so negatives read the same', () => {
    expect(formatParamNumber(-440)).toBe('-440');
    expect(formatParamNumber(-12.54)).toBe('-12.5');
    expect(formatParamNumber(-20000)).toBe('-20.0k');
  });

  it('appends units after one space, and omits the space when there are none', () => {
    expect(formatParamNumber(440, 'Hz')).toBe('440 Hz');
    expect(formatParamNumber(0, 'dB')).toBe('0.00 dB');
    expect(formatParamNumber(440, '')).toBe('440');
    expect(formatParamNumber(440)).toBe('440');
  });

  it('is TOTAL — a non-finite value prints rather than throwing', () => {
    // Called every animation frame while a value moves; must never throw.
    expect(() => formatParamNumber(NaN)).not.toThrow();
    expect(formatParamNumber(NaN)).toBe('NaN');
    expect(formatParamNumber(Infinity, 'Hz')).toBe('Infinityk Hz');
  });

  it('pins the exact boundary values of every rung', () => {
    // The rungs are >=, so each boundary belongs to the HIGHER rung.
    expect(formatParamNumber(10)).toBe('10.0');
    expect(formatParamNumber(9.999)).toBe('10.00');
    expect(formatParamNumber(100)).toBe('100');
    expect(formatParamNumber(99.99)).toBe('100.0');
    expect(formatParamNumber(1000)).toBe('1.00k');
    expect(formatParamNumber(999.9)).toBe('1000');
    expect(formatParamNumber(10000)).toBe('10.0k');
    expect(formatParamNumber(9999)).toBe('10.00k');
  });
});

describe('isBipolarRange', () => {
  it('is true only when the range STRADDLES zero', () => {
    expect(isBipolarRange(-1, 1)).toBe(true);
    expect(isBipolarRange(-50, 50)).toBe(true);
    expect(isBipolarRange(-24, 12)).toBe(true);
    expect(isBipolarRange(0, 1)).toBe(false); // touching zero is not straddling
    expect(isBipolarRange(-1, 0)).toBe(false);
    expect(isBipolarRange(20, 20000)).toBe(false);
  });
});

// ── The source-level guard ────────────────────────────────────────────────
// A component that re-declares the ladder locally is invisible to every
// runtime gate: it renders, it looks right, and it silently drifts. So grep.

// `Fader.svelte` was the third entry until #1794 migrated every call site to
// `NeonFader` and deleted it. The roster follows the SHIPPED primitives — a
// row naming a component that no longer exists cannot guard anything.
const PRIMITIVES = ['Knob.svelte', 'KnobConic.svelte', 'NeonFader.svelte'] as const;

function readPrimitive(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

describe('the readout ladder has exactly ONE implementation', () => {
  it.each(PRIMITIVES)('%s imports formatParamNumber instead of re-declaring it', (name) => {
    const src = readPrimitive(name);
    expect(src, `${name} must import the shared formatter`).toContain(
      "from './param-format'",
    );
    expect(src, `${name} must import formatParamNumber by name`).toMatch(
      /import \{[^}]*\bformatParamNumber\b[^}]*\} from '\.\/param-format'/,
    );
  });

  it.each(PRIMITIVES)('%s declares no local k-suffix ladder', (name) => {
    const src = readPrimitive(name);
    // The tell-tale of a copy-pasted ladder: the 10000 rung with a /1000 k
    // suffix. If this ever reappears, that component has forked the readout.
    expect(
      src,
      `${name} re-declares the readout ladder — import formatParamNumber from './param-format' instead`,
    ).not.toMatch(/abs >= 10000/);
  });

  it('the fader shares the ONE bipolar test rather than re-typing min < 0 && max > 0', () => {
    const src = readPrimitive('NeonFader.svelte');
    expect(src).toMatch(/isBipolarRange\(min, max\)/);
    expect(src, 'the fader must not re-type the bipolar predicate').not.toMatch(
      /\$derived\(min < 0 && max > 0\)/,
    );
  });

  it('the roster names only primitives that EXIST (anchored, so a deleted one is RED)', () => {
    // Without this, the clauses above go green the day a named file is
    // deleted and `readPrimitive` starts throwing... which is exactly what
    // #1794 caused, loudly. Anchoring makes the next one a one-line diagnosis.
    const present = new Set(readdirSync(fileURLToPath(new URL('.', import.meta.url))));
    expect(
      PRIMITIVES.filter((p) => !present.has(p)),
      'these PRIMITIVES name control files that do not exist (renamed? deleted?)',
    ).toEqual([]);
  });
});
