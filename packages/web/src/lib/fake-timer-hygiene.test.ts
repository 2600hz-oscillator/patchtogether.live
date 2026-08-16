// fake-timer-hygiene.test.ts
//
// A test file that fakes the global clock must put it back.
//
// THE INCIDENT (#1728's PR, 2026-08-16). `node-launchpad-monitor-registry.test.ts`
// called `vi.useFakeTimers()` in two `beforeEach` blocks and never restored.
// `packages/web/vitest.config.ts` runs the WHOLE unit suite in ONE process
// (`pool: 'forks'`, `poolOptions.forks.singleFork: true`, for determinism), so
// the patched global `setTimeout` was inherited by every test file that ran
// afterwards. CI went red on THREE unrelated files — the same-domain video
// CV/gate bridge, the reconciler, and the Push 2 display — each failing on an
// `await new Promise((r) => setTimeout(r, n))` that, under fake timers, never
// resolves and reports as `Test timed out in 5000ms`.
//
// ⚠ WHY IT WAS CI-ONLY, which is the part worth remembering. Vitest's default
// SEQUENCER orders files by SIZE DESCENDING when there is no
// `node_modules/.vite/vitest` timing cache — i.e. on a fresh CI checkout. The
// offending file was larger than the three it broke, so on CI it ran FIRST.
// Locally the cache reordered by recorded duration and happened to run it LAST,
// so the full suite passed on the same commit. "Passes locally, fails on CI" was
// not load, not flake and not the environment: it was file order. Clearing that
// cache reproduced CI exactly.
//
// The lesson generalises past timers — anything that patches a global in a
// single-process pool is a cross-file hazard — but timers are the case that has
// actually bitten, and they are cheaply checkable, so this gate is deliberately
// narrow rather than aspirational.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** packages/web/src — the root of the suite this vitest project runs. */
const SRC_ROOT = new URL('../', import.meta.url).pathname;

/** This file. It necessarily NAMES the calls it polices (in prose and in the
 *  synthetic sources its controls use), so it would flag itself. Excluded by
 *  path and ANCHORED below: if the name stops resolving, the exclusion is dead
 *  and the assertion reds rather than quietly covering some other file. */
const SELF = 'lib/fake-timer-hygiene.test.ts';

function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...testFilesUnder(p));
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** The predicate the gate and BOTH its controls call, so a green gate and a
 *  green control are statements about the same code.
 *
 *  A file is an offender when it installs fake timers and never mentions the
 *  restore. Both restore styles in the repo count: an `afterEach` hook, and a
 *  `try { … } finally { vi.useRealTimers(); }` inside a single test. */
function fakesTheClockWithoutRestoring(source: string): boolean {
  return /\buseFakeTimers\s*\(/.test(source) && !/\buseRealTimers\s*\(/.test(source);
}

describe('a test that fakes the global clock puts it back (single-process pool)', () => {
  const files = testFilesUnder(SRC_ROOT);

  it('scanned a real, non-trivial set of test files (else the gate is vacuous)', () => {
    // A bad root resolves to nothing and the assertion below passes for free.
    // Anchor on ARTIFACTS: this file, and a known fake-timer user.
    expect(files.some((f) => relative(SRC_ROOT, f) === SELF), `${SELF} must resolve`).toBe(true);
    expect(
      files.some((f) => f.endsWith('lib/audio/scheduler-clock.test.ts')),
      'a known fake-timer user must be in the scanned set',
    ).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });

  it('…and the scan actually SEES fake-timer users (the subject is non-empty)', () => {
    // Without this, "no offenders" would be indistinguishable from "the matcher
    // never matched anything at all" — the blind-gate failure mode. Rows, not a
    // count: a caller asserts membership, never how many there are.
    const users = files
      .filter((f) => /\buseFakeTimers\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_ROOT, f));
    expect(users, 'the population this gate polices must be non-empty').not.toEqual([]);
    expect(users).toContain('lib/audio/scheduler-clock.test.ts');
  });

  it('no test file leaves fake timers installed for the next file in the process', () => {
    const offenders = files
      .map((f) => relative(SRC_ROOT, f))
      .filter((rel) => rel !== SELF)
      .filter((rel) => fakesTheClockWithoutRestoring(readFileSync(join(SRC_ROOT, rel), 'utf8')));
    expect(
      offenders,
      'this suite runs in ONE process (singleFork), so an unrestored vi.useFakeTimers() ' +
        'patches the global clock for every LATER test file. The symptom is unrelated files ' +
        'timing out on `await new Promise(r => setTimeout(r, n))`, and it reproduces only in ' +
        "the sequencer order a FRESH checkout picks — so it reads as \"passes locally, fails " +
        'on CI". Restore in an afterEach, or in a try/finally.',
    ).toEqual([]);
  });

  it('PERMANENT POSITIVE CONTROL: the predicate DOES flag the shape that broke CI', () => {
    // Reduced from the offending file. If the matcher cannot see this, the empty
    // offender list above means "it matches nothing", not "every file restores".
    const bad = [
      `beforeEach(() => {`,
      `  vi.useFakeTimers();`,
      `});`,
      `it('drives the pump', async () => { await vi.advanceTimersByTimeAsync(50); });`,
    ].join('\n');
    expect(fakesTheClockWithoutRestoring(bad)).toBe(true);
  });

  it('PERMANENT NEGATIVE CONTROL: it does NOT flag either restore style, or a file with no timers', () => {
    const viaHook = `beforeEach(() => vi.useFakeTimers());\nafterEach(() => { vi.useRealTimers(); });`;
    const viaFinally = `it('x', () => { vi.useFakeTimers(); try { go(); } finally { vi.useRealTimers(); } });`;
    const noTimers = `it('x', async () => { await new Promise((r) => setTimeout(r, 5)); });`;
    expect(fakesTheClockWithoutRestoring(viaHook)).toBe(false);
    expect(fakesTheClockWithoutRestoring(viaFinally)).toBe(false);
    expect(fakesTheClockWithoutRestoring(noTimers)).toBe(false);
  });
});

// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate:
//   * PAIRING. It checks that a restore EXISTS in the file, not that every
//     install is matched by one on every path. A file that restores in one test
//     and forgets in another passes here.
//   * A restore that is written but never REACHED (an early `return`, a throw
//     before the `finally`, a hook on a `describe` that is `.skip`ped).
//   * Any OTHER patched global — `vi.stubGlobal`, a monkey-patched
//     `performance.now`, a replaced `requestAnimationFrame`. Same single-process
//     hazard, not this gate's subject.
//   * Other vitest projects. Scope is `packages/web/src/**/*.test.ts`; `art/`
//     also runs `singleFork: true` and is NOT covered here.
