// scripts/test-reconciliation.test.ts
//
// Unit coverage for the Test Reconciliation counter — the load-bearing logic
// is the static-disable vs runtime-guard vs parametrized-placeholder
// distinction (the whole point of the report's honesty). We drive countTests()
// against synthetic spec sources written to a temp dir so the assertions are
// exact + don't drift with the real repo's test count.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
// Runtime helpers from the plain .mjs counter (no .d.ts; vitest resolves the
// .mjs at runtime). Typed loosely on purpose — these are the load-bearing
// parsing fns we assert against synthetic fixtures below.
import * as recon from './test-reconciliation.mjs';
const { countTests, extractRecordKeys } = recon as {
  countTests: (files: string[]) => {
    total: number;
    disabled: number;
    skip: number;
    fixme: number;
    only: number;
    describeSkip: number;
    parametrized: number;
    onlyLocations: string[];
  };
  extractRecordKeys: (src: string, name: string) => Set<string>;
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recon-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function spec(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('countTests — static vs runtime-guard vs parametrized', () => {
  it('counts plain test()/it() as scheduled cases', () => {
    const f = spec('plain.spec.ts', `
      test('a', () => {});
      it('b', () => {});
      test("c", async () => {});
    `);
    const r = countTests([f]);
    expect(r.total).toBe(3);
    expect(r.disabled).toBe(0);
  });

  it('counts STATIC test.skip/test.fixme as disabled', () => {
    const f = spec('static-skip.spec.ts', `
      test('runs', () => {});
      test.skip('off', () => {});
      test.fixme('todo', () => {});
      it.skip('also off', () => {});
    `);
    const r = countTests([f]);
    expect(r.total).toBe(4);
    expect(r.skip).toBe(2); // test.skip + it.skip
    expect(r.fixme).toBe(1);
    expect(r.disabled).toBe(3);
  });

  it('does NOT count in-body runtime guards (test.skip(cond,…)) as tests or disables', () => {
    const f = spec('runtime-guard.spec.ts', `
      test('gated', () => {
        test.skip(!!process.env.CI, 'flaky on CI');
        test.skip(true, 'asset missing');
        if (!ok) test.skip(true, 'relay flake');
      });
    `);
    const r = countTests([f]);
    expect(r.total).toBe(1); // only the outer test()
    expect(r.disabled).toBe(0); // guards are env gates, not disables
  });

  it('counts loop-generated (interpolated-title) cases as parametrized, not raw', () => {
    const f = spec('param.spec.ts', `
      test('real static one', () => {});
      for (const m of REGISTRY) {
        test(\`\${m.type} renders\`, () => {});
        test.fixme(\`\${m.type} [SKIPPED: \${reason}]\`, () => {});
      }
    `);
    const r = countTests([f]);
    expect(r.total).toBe(1); // only the static test()
    expect(r.parametrized).toBe(2); // the two interpolated-title cases
    expect(r.disabled).toBe(0); // the interpolated fixme is parametrized, not raw-disabled
  });

  it('flags .only as an alert and a disable', () => {
    const f = spec('only.spec.ts', `
      test('normal', () => {});
      test.only('focused', () => {});
      describe.only('focused block', () => {});
    `);
    const r = countTests([f]);
    expect(r.only).toBe(2); // test.only + describe.only
    expect(r.onlyLocations.length).toBe(2);
    expect(r.onlyLocations[0]).toMatch(/only\.spec\.ts:\d+/);
    expect(r.disabled).toBeGreaterThanOrEqual(2);
  });

  it('counts describe.skip as a disabled block (structural, not a test)', () => {
    const f = spec('describe-skip.spec.ts', `
      describe('on', () => { test('x', () => {}); });
      describe.skip('off block', () => { test('y', () => {}); });
    `);
    const r = countTests([f]);
    expect(r.describeSkip).toBe(1);
    // The two inner test() still count toward total (we don't prune block bodies).
    expect(r.total).toBe(2);
    expect(r.disabled).toBe(1); // the describe.skip
  });

  it('counts test.todo as disabled', () => {
    const f = spec('todo.spec.ts', `
      test.todo('write me later');
      test('done', () => {});
    `);
    const r = countTests([f]);
    expect(r.total).toBe(2);
    expect(r.skip).toBe(1); // todo rolled into skip
    expect(r.disabled).toBe(1);
  });
});

describe('extractRecordKeys — exemption map parsing', () => {
  it('extracts quoted + bare-ident keys from a flat record literal', () => {
    const src = `
      const EXEMPT: Record<string, string> = {
        // a comment
        'moduleA.port1': 'reason one',
        bareModule: 'reason two',
        "moduleB.port2": 'reason three',
      };
    `;
    const keys = extractRecordKeys(src, 'EXEMPT');
    expect(keys.has('moduleA.port1')).toBe(true);
    expect(keys.has('bareModule')).toBe(true);
    expect(keys.has('moduleB.port2')).toBe(true);
    expect(keys.size).toBe(3);
  });

  it('returns an empty set when the const is absent', () => {
    expect(extractRecordKeys('const OTHER = {};', 'MISSING').size).toBe(0);
  });

  it('does not mistake a colon inside a value string for a key', () => {
    const src = `
      const M = {
        'k1': 'value with: a colon inside',
        k2: 'plain',
      };
    `;
    const keys = extractRecordKeys(src, 'M');
    expect([...keys].sort()).toEqual(['k1', 'k2']);
  });
});

describe('behavioral exemptions are ALL reconciliation backlog (no permanent-exempt bucket)', () => {
  // The reconciliation law: EVERY disabled test is backlog. There is NO
  // "intentional / correct-by-design" permanent-exempt bucket — the old
  // intentional-vs-reconcilable split was retired. A module leaves the disabled
  // count ONLY by being re-enabled-and-asserting or by having its assertion
  // deleted. These tests lock that against the LIVE spec source so the split
  // can't silently creep back.
  const specPath = fileURLToPath(
    new URL('../e2e/tests/per-module-per-port-behavioral.spec.ts', import.meta.url),
  );
  const specSrc = readFileSync(specPath, 'utf8');

  it('the retired RECONCILABLE/INTENTIONAL split maps are GONE from the spec', () => {
    // Guard against the two-bucket framing creeping back: neither the split
    // constant nor an "intentional" partner constant should be DECLARED.
    // (A passing prose mention of the retired name in a comment is fine —
    // extractRecordKeys / a const-declaration check ignore comments.)
    expect(extractRecordKeys(specSrc, 'BEHAVIORAL_RECONCILABLE_EXEMPT').size).toBe(0);
    expect(extractRecordKeys(specSrc, 'BEHAVIORAL_INTENTIONAL_EXEMPT').size).toBe(0);
    expect(/\bconst\s+BEHAVIORAL_RECONCILABLE_EXEMPT\b/.test(specSrc)).toBe(false);
    expect(/\bconst\s+BEHAVIORAL_INTENTIONAL_EXEMPT\b/.test(specSrc)).toBe(false);
  });

  it('re-enabled Moog routers are OUT of the module-exempt map (count fell)', () => {
    const moduleExempt = extractRecordKeys(specSrc, 'BEHAVIORAL_MODULE_EXEMPT');
    // Re-enabled in behavioral-recon #1/#2/#4 — must be fully out.
    for (const m of ['moog984', 'moog993', 'moog961', 'moog960']) {
      expect(moduleExempt.has(m)).toBe(false);
    }
  });

  it('still-disabled modules carry a module-exempt note (backlog, not silent)', () => {
    const moduleExempt = extractRecordKeys(specSrc, 'BEHAVIORAL_MODULE_EXEMPT');
    // Whatever remains disabled is ALL backlog — fix or delete. A representative
    // slice that's still exempt this leg (each a backlog item with a re-enable
    // path or a delete rationale in its note).
    for (const m of ['moog911a', 'buggles', 'mixmstrs', 'audioOut']) {
      expect(moduleExempt.has(m)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('produces identical counts across repeated runs on the same input', () => {
    const f = spec('det.spec.ts', `
      test('a', () => {});
      test.skip('b', () => {});
      for (const x of L) test(\`\${x}\`, () => {});
    `);
    const a = JSON.stringify(countTests([f]));
    const b = JSON.stringify(countTests([f]));
    expect(a).toBe(b);
  });
});
