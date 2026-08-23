// packages/web/src/lib/ui/workflow/shell-faces-roster.test.ts
//
// THE JOIN BETWEEN THE VRT FACE ROSTER AND THE LIVE DEFS.
//
// `e2e/vrt/_shell-faces.ts` declares, per face, facts the VRT scenes branch on:
// how many `pages` the dock should render, and whether the tab rail is an
// owner-instructed OPT-IN (`tabbedOptIn`). Both are COPIES of something the def
// already says.
//
// ⚠ THEY ARE COPIES FOR A RUNTIME REASON, NOT A DESIGN ONE. The VRT specs run
// under Playwright, and importing the module registry there pulls in
// `import.meta.glob`, which does not exist in that runtime — measured, while
// wiring the opt-in through: `TypeError: (intermediate value).glob is not a
// function`. So the roster cannot read a live def, and the numbers must be
// written down beside the scene.
//
// This file is the thing that stops them drifting. It runs in the UNIT lane,
// where the live defs ARE importable, and joins the two IN BOTH DIRECTIONS. It
// is the same shape as every other anchored list in this repo: a declaration is
// allowed to be a copy exactly as long as something red-flags the copy going
// stale.
//
// ⚠ WHAT IT CANNOT SEE: whether the roster is MISSING a promoted face
// altogether. That is `workflow-shell-faces.spec.ts`'s own `STRICT_FACES` ↔
// `FACES` clause, which owns that question and says so; this file only checks
// the per-entry facts of the faces the roster does list.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { faceForcesTabs } from './dock-tabs-model';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROSTER = resolve(HERE, '../../../../../../e2e/vrt/_shell-faces.ts');

/**
 * The roster's entries, parsed from SOURCE.
 *
 * Read as text rather than imported because `_shell-faces.ts` pulls in
 * `@playwright/test`, which has no business being loaded into the unit lane.
 * The parse is deliberately narrow — a `type:` line and the two flags — so it
 * fails loudly if the file's shape changes rather than silently matching
 * nothing (the anti-vacuity leg below is what enforces that).
 */
function rosterEntries(): { type: string; tabbedOptIn: boolean }[] {
  const src = readFileSync(ROSTER, 'utf8');
  const start = src.indexOf('export const FACES = [');
  expect(start, 'the FACES roster must be findable in _shell-faces.ts').toBeGreaterThan(-1);
  const end = src.indexOf('\n] as const', start) > 0 ? src.indexOf('\n] as const', start) : src.indexOf('\n];', start);
  const body = src.slice(start, end);

  // Split on entry boundaries: every `type: '<x>'` starts one, and the flag (if
  // present) belongs to the entry it follows.
  const out: { type: string; tabbedOptIn: boolean }[] = [];
  const re = /type:\s*'([A-Za-z0-9_]+)'/g;
  const marks: { type: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) marks.push({ type: m[1]!, at: m.index });
  for (const [i, mark] of marks.entries()) {
    const segment = body.slice(mark.at, marks[i + 1]?.at ?? body.length);
    out.push({ type: mark.type, tabbedOptIn: /tabbedOptIn:\s*true/.test(segment) });
  }
  return out;
}

function liveDefs(): { type: string; face?: { tabbed?: boolean; pages?: unknown[] } }[] {
  return [
    ...(listModuleDefs() as unknown as { type: string; face?: { tabbed?: boolean; pages?: unknown[] } }[]),
    ...(listVideoModuleDefs() as unknown as { type: string; face?: { tabbed?: boolean; pages?: unknown[] } }[]),
  ];
}

describe('the VRT face roster agrees with the live defs', () => {
  it('every roster `tabbedOptIn` matches the def, and every opted-in def is flagged', () => {
    const entries = rosterEntries();
    const byType = new Map(liveDefs().map((d) => [d.type, d]));
    const mismatches: string[] = [];

    // Direction 1: the roster says opt-in ⇒ the def must declare it.
    for (const e of entries) {
      const def = byType.get(e.type);
      if (!def) continue; // roster membership is the other spec's clause
      const declared = faceForcesTabs(def);
      if (e.tabbedOptIn !== declared) {
        mismatches.push(
          `${e.type}: roster tabbedOptIn=${e.tabbedOptIn} but the def declares face.tabbed=${declared}`,
        );
      }
    }

    // Direction 2: a def that declares the opt-in must be flagged in the roster
    // — otherwise the dock scene computes `railed` from the threshold alone and
    // fails on the very rail the owner asked for.
    const flagged = new Set(entries.filter((e) => e.tabbedOptIn).map((e) => e.type));
    const rosterTypes = new Set(entries.map((e) => e.type));
    for (const def of liveDefs()) {
      if (!faceForcesTabs(def)) continue;
      if (!rosterTypes.has(def.type)) continue;
      if (!flagged.has(def.type)) {
        mismatches.push(`${def.type}: declares face.tabbed but the VRT roster does not flag it`);
      }
    }

    expect(
      mismatches,
      'the VRT roster and the live defs disagree about the tab rail. The roster is a COPY (the ' +
        'Playwright runtime cannot import the registry), so it has to be corrected by hand here.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the parse actually found the roster, and discriminates', () => {
    // Both directions above are equality checks over a parsed list — they pass
    // vacuously if the parse returns nothing, which is exactly how a roster
    // whose shape changed would look.
    const entries = rosterEntries();
    expect(entries.length, 'the roster parse found no entries').toBeGreaterThan(20);
    expect(
      entries.some((e) => e.tabbedOptIn),
      'no roster entry is flagged as an opt-in — spirographs should be',
    ).toBe(true);
    expect(
      entries.some((e) => !e.tabbedOptIn),
      'EVERY entry parsed as an opt-in, so the flag test matches indiscriminately',
    ).toBe(true);
  });
});
