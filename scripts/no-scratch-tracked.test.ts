// scripts/no-scratch-tracked.test.ts
//
// DENYLIST GATE: agent scratch / generated-report trees must never be TRACKED.
//
// Why this exists, measured 2026-08-09: five files under
// `private/tmp/claude-501/-Users-2600hz-Documents-workspace-inet-modular/
// 2ffc60a3-…/scratchpad/gallery-out/` were committed and reached **public
// main**. Between them they published a local username, an absolute home path,
// an agent session UUID and generated VRT diff artifacts.
//
// `.gitignore` alone cannot prevent this and did not:
//   - an already-tracked path keeps being tracked no matter what the ignore
//     file says, and
//   - `git add -f` bypasses it entirely.
// So the ignore rules are the convenience and THIS is the gate.
//
// Anchored to the ARTIFACT: it reads `git ls-files`, i.e. what is actually
// tracked right now — not a list someone maintains. There is no exemption
// list and there should never be one; if a real source path ever legitimately
// matches one of these patterns, rename the path.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Patterns that may never appear in a tracked path. */
const DENY: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /(^|\/)private\//, why: 'agent scratch root (`private/`) — local paths + session UUIDs' },
  { re: /(^|\/)scratchpad\//, why: 'agent scratchpad — working files, never project content' },
  { re: /(^|\/)gallery-out\//, why: 'generated VRT gallery output — a build artifact' },
  { re: /claude-\d+\//, why: 'agent host-scratch dir (`claude-<uid>/`) — leaks a local uid' },
  {
    // 8-4-4-4-12 hex: an agent SESSION UUID as a path segment.
    re: /(^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i,
    why: 'session-UUID directory — agent run identity',
  },
  { re: /(^|\/)-Users-/, why: 'flattened absolute home path (`-Users-…`) — leaks a username' },
];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

describe('no agent scratch or generated-report tree is tracked', () => {
  it('every tracked path clears the denylist', () => {
    const files = trackedFiles();
    // Guard the instrument: if this ever reads an empty tree the assertion
    // below would pass vacuously.
    expect(files.length).toBeGreaterThan(1000);

    const offenders = files.flatMap((f) => {
      const hit = DENY.find((d) => d.re.test(f));
      return hit ? [`${f}\n      ↳ ${hit.why}`] : [];
    });

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Tracked path(s) match the agent-scratch denylist. These leak local identity ` +
          `into public history — untrack them (\`git rm -r --cached <path>\`) rather than ` +
          `adding an exemption:\n    ${offenders.join('\n    ')}`,
    ).toEqual([]);
  });

  it('the denylist itself is live — a synthetic scratch path is rejected', () => {
    // NEGATIVE CONTROL. Without this, a denylist whose regexes all silently
    // stopped matching would keep passing forever on a clean tree.
    const synthetic = [
      'private/tmp/claude-501/x/scratchpad/gallery-out/index.html',
      'packages/web/src/lib/2ffc60a3-c8f8-46ab-86cb-6ffeae3fd374/x.ts',
      'tools/-Users-someone-workspace/notes.md',
    ];
    for (const p of synthetic) {
      expect(DENY.some((d) => d.re.test(p)), `denylist failed to reject ${p}`).toBe(true);
    }
    // …and it must not reject ordinary source paths.
    for (const p of [
      'packages/web/src/lib/audio/modules/vca.ts',
      'e2e/vrt/__screenshots__/vrt.spec.ts/linux/adsr.png',
      '.myrobots/plans/face-specs-batch-4-INDEX.md',
    ]) {
      expect(DENY.some((d) => d.re.test(p)), `denylist wrongly rejected ${p}`).toBe(false);
    }
  });
});
