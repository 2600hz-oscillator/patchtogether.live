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
// `face:` is EXACTLY THE SAME KIND OF FIELD and was not covered. It is UI
// curation — control ranking, band labels, the glyph choice, rear grouping —
// and it reaches no audio code either, but it sat INSIDE the hash. So a pure
// re-ranking moved `art/baselines/delay/audio.sha`, and the face program was
// about to drag an audio re-pin behind every cosmetic edit on this set.
//
// THIS GATE IS THE DURABLE HALF OF THE FIX. Wrapping delay's `face:` in the
// markers is a one-time edit; without a gate, the NEXT def in this set to grow
// a face repeats the bug silently — the `.sha` just moves, CI goes red, and a
// tired human re-pins it as "expected churn". Instead: any def pinned by
// `docsStrippedRepoSourceSha` that carries an UNWRAPPED hash-transparent field
// fails here, in the `art` lane, naming the field.
//
// WHY A SOURCE SCAN AND NOT A RENDER: the claim is about which BYTES feed the
// hash, so the bytes are the right thing to read. It needs no audio graph, no
// LFS, and no numpy — it cannot skip-pass.

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripDocsForPin } from '../setup/capture';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCENARIOS = join(REPO_ROOT, 'art/scenarios');

/**
 * The fields that are HASH-TRANSPARENT BY POLICY — cosmetic/UI metadata that
 * reaches no audio code. Each must live inside a `docs-hash-ignore` region on
 * a def whose source file is an ART pin basis.
 *
 * `params`/`inputs`/`outputs`/`factory` are deliberately NOT here: those DO
 * shape the audio, and their bytes belong in the pin.
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
    // delay + scaler + polarizer + illogic + depolarizer today. The FLOOR is
    // what matters: if this drops to 0 the whole gate silently passes.
    expect(pinned.length, 'no docsStrippedRepoSourceSha pins found — did the helper get renamed?')
      .toBeGreaterThanOrEqual(5);
  });

  it('every hash-transparent field on a PINNED def sits inside a docs-hash-ignore region', async () => {
    const violations: string[] = [];
    for (const { scenario, rel } of await pinnedDefSources()) {
      const src = await readFile(join(REPO_ROOT, rel), 'utf8');
      // What actually feeds the hash: the source with the marked regions gone.
      const hashed = stripDocsForPin(src);
      for (const field of TRANSPARENT_FIELDS) {
        // Top-level def field: two-space indent inside the object literal.
        const declared = new RegExp(`^  ${field}:`, 'm');
        if (!declared.test(src)) continue;
        if (declared.test(hashed)) {
          violations.push(
            `${rel} (pinned by art/scenarios/${scenario}): \`${field}:\` is INSIDE the audio hash — ` +
              `wrap it in \`// docs-hash-ignore:start … :end\` and re-pin the .sha ONCE, ` +
              `or every cosmetic edit to it will move ${scenario}'s audio baseline.`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the strip is a NO-OP on a def with no markers (it cannot silently eat audio code)', async () => {
    // Guards the other direction: an over-broad regex that swallowed the
    // factory would make the pin meaningless while looking green.
    const plain = 'export const def = {\n  type: "x",\n  params: [],\n};\n';
    expect(stripDocsForPin(plain)).toBe(plain);
  });

  it('stripping removes the marked region AND its markers, but nothing after it', async () => {
    const src = [
      'const a = 1;',
      '  // docs-hash-ignore:start',
      '  face: { order: [] },',
      '  // docs-hash-ignore:end',
      'const b = 2;',
      '',
    ].join('\n');
    expect(stripDocsForPin(src)).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('two SEPARATE regions strip independently (delay carries face + docs)', async () => {
    const src = [
      'a',
      '// docs-hash-ignore:start',
      'FACE',
      '// docs-hash-ignore:end',
      'KEEP',
      '// docs-hash-ignore:start',
      'DOCS',
      '// docs-hash-ignore:end',
      'b',
      '',
    ].join('\n');
    // A greedy match would eat KEEP along with both regions.
    expect(stripDocsForPin(src)).toBe('a\nKEEP\nb\n');
  });
});
