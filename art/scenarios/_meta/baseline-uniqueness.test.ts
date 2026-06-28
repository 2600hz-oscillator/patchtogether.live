// art/scenarios/_meta/baseline-uniqueness.test.ts
//
// HONESTY GUARD for the ART baseline corpus.
//
// An ART scenario "passes" by rendering a buffer and comparing it (RMS tier)
// to a committed `.f32` baseline. If TWO scenarios share a byte-identical
// baseline, at least one of them is almost always a STUB comparing a fixed
// placeholder against itself — a required CI gate that is green by
// construction, not because the module's audio is correct.
//
// (Root cause at the time of writing: art/setup/render.ts's Phase-1 `render()`
// stub ignores `opts.moduleName` and returns the SAME 440 Hz sine for every
// module, so ~11 module baselines were byte-identical — md5 8313a1e7… — and a
// further 2 cube configs collapsed to the same constant −1.0 floor. Those stub
// scenarios + baselines were deleted; this guard keeps the corpus honest so a
// new stub can't silently re-introduce a self-comparing baseline.)
//
// This is a PURE unit guard: it just md5-hashes every committed baseline and
// asserts no two share a hash. It needs no DSP build and adds ~0 CI wall-time.
// It works on git-lfs POINTER files too (identical content ⇒ identical oid ⇒
// identical pointer ⇒ still flagged), so it is meaningful even when lfs is not
// materialised.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINES_DIR = fileURLToPath(new URL('../../baselines/', import.meta.url));

/** Recursively collect every `.f32` baseline path under art/baselines/. */
function collectF32(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectF32(full));
    else if (ent.isFile() && ent.name.endsWith('.f32')) out.push(full);
  }
  return out;
}

describe('ART baselines — uniqueness honesty guard', () => {
  it('no two .f32 baselines are byte-identical (a shared hash ⇒ a stub vs itself)', () => {
    const files = collectF32(BASELINES_DIR).sort();
    // Sanity: there ARE baselines to check (catches a broken path / empty dir).
    expect(files.length, 'no .f32 baselines found under art/baselines/').toBeGreaterThan(0);

    const byHash = new Map<string, string[]>();
    for (const f of files) {
      const md5 = createHash('md5').update(readFileSync(f)).digest('hex');
      const rel = f.slice(BASELINES_DIR.length);
      (byHash.get(md5) ?? byHash.set(md5, []).get(md5)!).push(rel);
    }

    const collisions = [...byHash.entries()].filter(([, paths]) => paths.length > 1);
    const report = collisions
      .map(([md5, paths]) => `  ${md5}:\n${paths.map((p) => `    - ${p}`).join('\n')}`)
      .join('\n');

    expect(
      collisions.length,
      collisions.length === 0
        ? ''
        : `${collisions.length} group(s) of byte-identical ART baselines found ` +
          `(${files.length} baselines checked). A shared hash means a scenario is ` +
          `comparing a stub/placeholder against itself — a fake-green gate. Either ` +
          `give each scenario a REAL distinct render, or delete the stub scenario + ` +
          `its baseline:\n${report}`,
    ).toBe(0);
  });
});
