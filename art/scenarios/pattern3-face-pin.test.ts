// art/scenarios/pattern3-face-pin.test.ts
//
// PF-11 — UI METADATA MUST NOT MOVE AN ART AUDIO PIN.
//
// The "pattern-3" scenarios pin their audio to the SOURCE FILE of the module
// def, because the def file IS the whole render path (a pure Web-Audio factory
// with no worklet and no separate lib to pin instead). `docsStrippedRepoSourceSha`
// exists so the co-located `docs:` prose does not count: prose reaches no audio
// code, and an audio `.sha` that moves for a typo fix stops meaning "the audio
// changed" — which is the only thing it is for.
//
// `face:` is EXACTLY THE SAME KIND OF FIELD. It is UI curation — control
// ranking, band labels, the glyph choice, rear grouping — and it reaches no
// audio code either, but it used to sit INSIDE the hash. So a pure re-ranking
// moved `art/baselines/delay/audio.sha`, and the face program was about to drag
// an audio re-pin behind every cosmetic edit on this set.
//
// THE MECHANISM CHANGED ON 2026-08-09 and this gate got STRONGER for it. The
// old fix was an opt-in comment marker each def had to remember to wrap its
// `face:` in, and this test checked for the marker. Now the shared attest
// normalizer (`scripts/attest-code-basis.ts`) strips comments and the
// `docs`/`controlFamilies`/`face` properties of any module-scope def BY
// CONSTRUCTION — the same normalizer the webgl attest uses (it backed the collab
// and grand attests too, until those were deleted 2026-08-17).
//
// So the check is no longer "is the ceremony present" (a proxy) but "does the
// LIVE hash basis actually still contain this field" (the artifact). That
// closes a real hole: a def could have carried the markers in the wrong place
// and passed the old gate.
//
// WHY A SOURCE SCAN AND NOT A RENDER: the claim is about which BYTES feed the
// hash, so the bytes are the right thing to read. It needs no audio graph, no
// LFS, and no numpy — it cannot skip-pass.

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripDocsForPin, docsStrippedRepoSourceSha } from '../setup/capture';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCENARIOS = join(REPO_ROOT, 'art/scenarios');

/**
 * The fields that are HASH-TRANSPARENT BY POLICY — cosmetic/UI metadata that
 * reaches no audio code.
 *
 * `params`/`inputs`/`outputs`/`factory` are deliberately NOT here: those DO
 * shape the audio, and their bytes belong in the pin. The `§negative` block
 * below asserts that, so this list cannot quietly grow into the audio.
 */
const TRANSPARENT_FIELDS = ['docs', 'face', 'controlFamilies'] as const;

/** Every `docsStrippedRepoSourceSha('<path>')` argument across the ART suite. */
async function pinnedDefSources(): Promise<{ scenario: string; rel: string }[]> {
  const out: { scenario: string; rel: string }[] = [];
  for (const scenario of await readdir(SCENARIOS, { withFileTypes: true })) {
    if (!scenario.isDirectory()) continue;
    const dir = join(SCENARIOS, scenario.name);
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.test.ts')) continue;
      const src = await readFile(join(dir, f), 'utf8');
      for (const m of src.matchAll(/docsStrippedRepoSourceSha\(\s*([^)]*)\)/g)) {
        for (const arg of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
          out.push({ scenario: scenario.name, rel: arg[1]! });
        }
      }
    }
  }
  return out;
}

describe('PF-11: UI metadata is hash-transparent to the ART source pins', () => {
  it('the pattern-3 set is discoverable (guards a refactor that renames the helper)', async () => {
    const pinned = await pinnedDefSources();
    // ⚠ `>= 5` STOOD HERE (removed 2026-08-12, the no-ratchets sweep). It read
    // as a vacuity floor and was not one: `pinnedDefSources()` is a DIRECTORY
    // WALK over art/scenarios/**, and the tree measured EXACTLY 5, so the floor
    // sat on its own population with zero slack. Retiring any one of the five
    // scenarios would have reddened it for no defect — which is not
    // hypothetical here, the 15-module deletion PR (537ed4b1) is precisely that
    // event — and two concurrent branches, one adding a pin and one removing
    // one, both write 5 and auto-merge to a wrong 5.
    //
    // The real claim was never "there are five". It was "the walk still finds
    // the helper", so it is asserted that way: non-empty, plus a NAME the set
    // must contain, which a renamed helper cannot satisfy and a shrinking
    // scenario roster does not disturb.
    expect(
      pinned.length,
      'no docsStrippedRepoSourceSha pins found at all — did the helper get renamed?',
    ).toBeGreaterThan(0);
    expect(
      pinned.map((p) => p.rel),
      'the walk resolved pins but not the canonical one — `delay.ts` has carried a ' +
        'pattern-3 source pin since the mechanism was introduced, so its absence means ' +
        'the scan is reading the wrong tree, not that the pin was retired',
    ).toContain('packages/web/src/lib/audio/modules/delay.ts');
  });

  it('no hash-transparent field on a PINNED def survives into the hashed content', async () => {
    const violations: string[] = [];
    for (const { scenario, rel } of await pinnedDefSources()) {
      const src = await readFile(join(REPO_ROOT, rel), 'utf8');
      // What actually feeds the pin: the def reduced to its CODE.
      const hashed = await stripDocsForPin(src, rel);
      for (const field of TRANSPARENT_FIELDS) {
        // Top-level def field: two-space indent inside the object literal.
        const declared = new RegExp(`^  ${field}:`, 'm');
        if (!declared.test(src)) continue;
        if (new RegExp(`^ {2,4}${field}:`, 'm').test(hashed)) {
          violations.push(
            `${rel} (pinned by art/scenarios/${scenario}): \`${field}:\` is INSIDE the audio hash — ` +
              `the attest normalizer did not reach it (is it nested rather than a ` +
              `module-scope def property?). Every cosmetic edit to it will move ` +
              `${scenario}'s audio baseline.`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('at least one pinned def really does carry a transparent field (non-vacuity)', async () => {
    // Without this, the gate above passes trivially if every def stops
    // declaring docs/face — which is exactly when it would stop protecting
    // anything.
    let found = 0;
    for (const { rel } of await pinnedDefSources()) {
      const src = await readFile(join(REPO_ROOT, rel), 'utf8');
      if (TRANSPARENT_FIELDS.some((f) => new RegExp(`^  ${f}:`, 'm').test(src))) found++;
    }
    expect(found, 'no pinned def declares docs/face/controlFamilies at all').toBeGreaterThanOrEqual(
      5,
    );
  });
});

describe('PF-11 §negative: the strip must not reach the AUDIO', () => {
  it('a comment-only edit to a pinned def does NOT move its .sha', async () => {
    const [first] = await pinnedDefSources();
    const rel = first!.rel;
    const src = await readFile(join(REPO_ROOT, rel), 'utf8');
    const commented = '// a fresh comment on the def\n' + src;
    expect(await stripDocsForPin(commented, rel)).toBe(await stripDocsForPin(src, rel));
  });

  it('a PARAM RANGE edit DOES move it (params/inputs/outputs/factory stay in the pin)', async () => {
    const bare = `export const d = {\n  docs: { a: 'x' },\n  params: [{ id: 'g', min: 0, max: 1 }],\n};\n`;
    const wider = `export const d = {\n  docs: { a: 'x' },\n  params: [{ id: 'g', min: 0, max: 2 }],\n};\n`;
    expect(await stripDocsForPin(bare, 'def.ts')).not.toBe(await stripDocsForPin(wider, 'def.ts'));
  });

  it('the strip cannot silently eat a def with nothing transparent in it', async () => {
    const plain = 'export const def = {\n  type: "x",\n  params: [],\n};\n';
    const out = await stripDocsForPin(plain, 'def.ts');
    expect(out).toContain('type: "x"');
    expect(out).toContain('params: []');
  });

  it('the pin helper is deterministic and 16 hex chars', async () => {
    const [first] = await pinnedDefSources();
    const a = await docsStrippedRepoSourceSha(first!.rel);
    const b = await docsStrippedRepoSourceSha(first!.rel);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
