// packages/web/src/lib/docs/contract-lock.test.ts
//
// The living-docs DRIFT GATE (.myrobots/plans/living-docs-drift-2026-06-24.md).
// Pure-unit, zero-flake: regenerate the canonical contract golden from the LIVE
// registry and string-compare to the committed `contract-lock.txt`. Any module
// I/O contract change (port add/remove/rename/retype, param range/curve/default,
// stereo/expose/control-family) produces a readable line diff and FAILS — until
// a human re-authors the doc + re-pins (`task docs:accept`) or recognizes a bug.
//
// This mirrors ART's source-`.sha` pin + VRT's baseline: CI NEVER self-heals
// (the write path is gated on DOCS_UPDATE). The whole comparison is string
// equality over an in-memory registry — no browser, no GPU, no render.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Side-effect barrels — registering every module def (same pattern as
// registry-manifest.test.ts). MUST precede the registry read below.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { serializeContractLock, serializeModuleContract } from './contract-signature';

const LOCK_PATH = fileURLToPath(new URL('./contract-lock.txt', import.meta.url));

/** Readable line diff (ignores the `#` header) so a failure shows WHAT changed,
 *  not the whole 1000-line golden. `-` = was committed, `+` = now live. */
function lineDiff(committed: string, current: string): string {
  const real = (s: string) =>
    new Set(s.split('\n').filter((l) => l.length > 0 && !l.startsWith('#')));
  const c = real(committed);
  const n = real(current);
  const removed = [...c].filter((l) => !n.has(l)).map((l) => `- ${l}`);
  const added = [...n].filter((l) => !c.has(l)).map((l) => `+ ${l}`);
  return [...removed.sort(), ...added.sort()].join('\n');
}

describe('contract-lock (living-docs drift gate)', () => {
  it('the committed contract golden matches the live module registry', () => {
    const current = serializeContractLock();

    if (process.env.DOCS_UPDATE) {
      // `task docs:accept` — the deliberate human re-pin (ART/VRT *:update analog).
      writeFileSync(LOCK_PATH, current, 'utf8');
      return;
    }

    let committed = '';
    try {
      committed = readFileSync(LOCK_PATH, 'utf8');
    } catch {
      committed = '';
    }

    const diff = committed === current ? '' : lineDiff(committed, current);
    expect(
      diff,
      'Module I/O contract drift detected (- committed / + live). A port/param/' +
        'control changed: re-author the affected docs and re-pin with ' +
        '`flox activate -- task docs:accept`, OR recognize this as a bug/side-effect ' +
        'and fix the def. The golden is packages/web/src/lib/docs/contract-lock.txt.',
    ).toBe('');
  });
});

// Prove the gate is NOT vacuous: canonicalization absorbs cosmetic reordering,
// but every real contract change produces a different serialization (so the
// golden diff fires). Fixture-based — no registry needed.
describe('contract-signature — canonical + change-detecting', () => {
  const base = {
    type: 'fixturemod',
    domain: 'audio',
    schemaVersion: 1,
    inputs: [
      { id: 'in_a', type: 'audio' },
      { id: 'gate', type: 'gate', edge: 'trigger' as const },
    ],
    outputs: [{ id: 'out', type: 'audio' }],
    params: [{ id: 'amount', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' }],
  };
  const sig = (d: Parameters<typeof serializeModuleContract>[0]): string =>
    serializeModuleContract(d).join('\n');

  it('is order-independent (reordering ports/params is NOT a contract change)', () => {
    const shuffled = {
      ...base,
      inputs: [base.inputs[1], base.inputs[0]],
      params: [...base.params],
    };
    expect(sig(shuffled)).toBe(sig(base));
  });

  it('detects an ADDED port', () => {
    const added = { ...base, inputs: [...base.inputs, { id: 'in_b', type: 'audio' }] };
    expect(sig(added)).not.toBe(sig(base));
    expect(sig(added)).toContain('fixturemod in in_b audio');
  });

  it('detects a RENAMED port', () => {
    const renamed = { ...base, inputs: [{ id: 'in_x', type: 'audio' }, base.inputs[1]] };
    expect(sig(renamed)).not.toBe(sig(base));
  });

  it('detects a RETYPED port', () => {
    const retyped = { ...base, inputs: [{ id: 'in_a', type: 'cv' }, base.inputs[1]] };
    expect(sig(retyped)).not.toBe(sig(base));
  });

  it('detects an edge trigger→gate flip', () => {
    const flipped = {
      ...base,
      inputs: [base.inputs[0], { id: 'gate', type: 'gate', edge: 'gate' as const }],
    };
    expect(sig(flipped)).not.toBe(sig(base));
  });

  it('detects a param range / default change', () => {
    const widened = { ...base, params: [{ ...base.params[0], max: 2 }] };
    expect(sig(widened)).not.toBe(sig(base));
    const redefaulted = { ...base, params: [{ ...base.params[0], defaultValue: 0.7 }] };
    expect(sig(redefaulted)).not.toBe(sig(base));
  });

  it('detects a new control family', () => {
    const withFamily = {
      ...base,
      controlFamilies: [
        { id: 'step', label: 'Steps', kind: 'step-grid' as const, testidPrefix: 'step-gate' },
      ],
    };
    expect(sig(withFamily)).not.toBe(sig(base));
    expect(sig(withFamily)).toContain('family step kind=step-grid prefix=step-gate');
  });
});
