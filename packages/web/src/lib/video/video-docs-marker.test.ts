// packages/web/src/lib/video/video-docs-marker.test.ts
//
// FAIL-FAST lint (owner directive 2026-06-25): a VIDEO module def lives in the
// WebGL attest hash basis (lib/video/** is swept), so authoring a co-located
// `docs:` / `controlFamilies:` block on it would churn the attest hash and force
// a ~10-min real-GPU re-attest — UNLESS the block is wrapped in
// `// docs-hash-ignore:start … // docs-hash-ignore:end` markers (computeWebglHash
// strips those regions via stripDocsForHash → the doc edit is a hash no-op; see
// webgl-attest-coverage.test.ts + fader.ts for the reference pattern).
//
// This guard catches a FORGOTTEN marker in seconds (unit lane) instead of a
// 25-min red `webgl-attest` gate. For every video module def file: if it declares
// a `docs:` or `controlFamilies:` block, that block must NOT survive
// stripDocsForHash() — i.e. it must be inside the markers.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripDocsForHash, REPO_ROOT } from '../../../../../scripts/webgl-attest-lib';

const VIDEO_MODULES_DIR = join(REPO_ROOT, 'packages/web/src/lib/video/modules');

// A def-field declaration: line-start whitespace, then `docs:` / `controlFamilies:`
// opening an object/array. (A `// docs:` comment or a `foo.docs` reference can't
// match because of the required line-start + `:` + `{`/`[`.)
const DEF_FIELD_RE = /\n[ \t]*(?:docs|controlFamilies):\s*[[{]/;

describe('video module docs/controlFamilies are docs-hash-ignore wrapped (attest no-op)', () => {
  const files = readdirSync(VIDEO_MODULES_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

  it('found video module def files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f}: any docs/controlFamilies block is wrapped in // docs-hash-ignore markers`, () => {
      const raw = readFileSync(join(VIDEO_MODULES_DIR, f), 'utf8');
      if (!DEF_FIELD_RE.test(raw)) return; // no doc block → nothing to wrap
      const stripped = stripDocsForHash(raw);
      expect(
        DEF_FIELD_RE.test(stripped),
        `${f} declares a docs:/controlFamilies: block NOT inside ` +
          `// docs-hash-ignore:start … // docs-hash-ignore:end markers. It would ` +
          `churn the WebGL attest hash and force a GPU re-attest. Wrap it (see fader.ts).`,
      ).toBe(false);
    });
  }
});
