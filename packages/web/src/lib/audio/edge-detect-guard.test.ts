// packages/web/src/lib/audio/edge-detect-guard.test.ts
//
// Source-scan regression guard for the overlap-rescan double-count bug class.
// The three main-thread consumers that had the bug (NUMPAD+ / HYDROGEN /
// ATLANTIS-CATALYST) must stay on the shared windowed `createEdgeCounter` seam
// and must NOT reintroduce a whole-buffer rising-edge rescan. This is a cheap
// static guard so a future refactor can't silently regress the fix.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES = resolve(__dirname, 'modules');

function src(file: string): string {
  return readFileSync(resolve(MODULES, file), 'utf8');
}

// The foot-gun: getFloatTimeDomainData(<buf>) drained, then a rising-edge count
// over the WHOLE buffer (`for (let s = 0; s < <buf>.length …)`). createEdgeCounter
// exists precisely so no consumer hand-rolls this again.
const WHOLE_BUFFER_SCAN = /for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\w+\.length/;

describe('edge-detect seam — main-thread consumers stay windowed (no whole-buffer rescan)', () => {
  for (const file of ['numpad-plus.ts', 'hydrogen.ts', 'atlantis-catalyst.ts']) {
    it(`${file} routes trigger/clock detection through createEdgeCounter`, () => {
      const code = src(file);
      expect(code, `${file} should import the shared edge counter`).toMatch(
        /createEdgeCounter/,
      );
    });

    it(`${file} no longer hand-rolls a getFloatTimeDomainData whole-buffer edge scan`, () => {
      const code = src(file);
      // Strip out level-only reads (freeze reads the LAST sample, not a scan):
      // we only flag a whole-buffer FOR-loop sitting next to a time-domain drain.
      const drainsTimeDomain = code.includes('getFloatTimeDomainData');
      if (!drainsTimeDomain) return; // no analyser drain at all → nothing to guard
      // Any remaining whole-buffer for-loop must NOT also do an edge compare
      // (`>= threshold && !last` style). The fixed files read levels only.
      const hasWholeBufferLoop = WHOLE_BUFFER_SCAN.test(code);
      const hasEdgeCompare = /&&\s*!?\w*[Ll]ast/.test(code);
      expect(
        hasWholeBufferLoop && hasEdgeCompare,
        `${file} appears to hand-roll a whole-buffer rising-edge scan again — `
          + 'route it through $lib/audio/edge-detect createEdgeCounter instead',
      ).toBe(false);
    });
  }
});
