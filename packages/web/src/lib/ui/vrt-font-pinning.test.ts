// packages/web/src/lib/ui/vrt-font-pinning.test.ts
//
// THE FONT-PINNING GATE for the VRT suite.
//
// Every VRT spec that captures a screenshot must pin the bundled Inter /
// JetBrains Mono faces BEFORE its first navigation (`pinVrtFonts`, which
// installs an `addInitScript` and therefore has to run pre-`goto`) and await
// their decode AFTER load (`awaitVrtFonts`). `e2e/vrt/_fonts.ts` has the full
// root cause; the short version is that the app resolves card text through
// GENERIC stacks (`system-ui`, `ui-monospace`), fontconfig picks the face
// nondeterministically on the ubuntu runner, and `document.fonts.ready` cannot
// see generic faces so it resolves instantly and the nondeterminism sails
// through.
//
// WHY A GATE AND NOT JUST THE FIX. The helper has existed since #598, and
// twenty specs written after it never called it — the suite drifted back into
// the exact flake the helper was built to kill, one new spec at a time, and
// nothing said a word. The failure is also NOT self-announcing: an unpinned
// spec passes on the machine that captured its baseline and fails on the one
// that did not, which reads as "CI is flaky" rather than "this spec never
// pinned its fonts".
//
// It is a SOURCE-level check because there is no runtime seam that can see it:
// by the time a screenshot is taken, a wrong-but-consistent face looks exactly
// like the right one. Same reasoning as the `controlFamilies` → card-testid
// grep in module-docs-lint (CLAUDE.md: guard a two-sided contract at the source
// when no runtime gate reads both sides).
//
// Pure fs + string work, no browser. ~10 ms.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const VRT_DIR = resolve(REPO_ROOT, 'e2e/vrt');

/**
 * Specs that navigate but capture NO screenshot, so no baseline of theirs can
 * rot from a font swap. They still have to be listed rather than silently
 * excluded — a spec that starts capturing must move out of here.
 */
const NO_CAPTURE_PROBES: readonly string[] = ['vrt-sr-probe.spec.ts'];

interface SpecFacts {
  spec: string;
  gotos: number;
  pins: number;
  awaits: number;
  shots: number;
  firstPinBeforeFirstGoto: boolean;
}

function count(src: string, re: RegExp): number[] {
  return [...src.matchAll(new RegExp(re.source, 'g'))].map((m) => m.index ?? -1);
}

function specFacts(): SpecFacts[] {
  return readdirSync(VRT_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((spec) => {
      const src = readFileSync(resolve(VRT_DIR, spec), 'utf8');
      const gotos = count(src, /page\.goto\(/);
      // The `import { pinVrtFonts, awaitVrtFonts } from './_fonts'` line names
      // both helpers without calling either — count only the `name(` CALL form,
      // which the import (a bare identifier in a binding list) never matches.
      const callPins = count(src, /pinVrtFonts\(/);
      const callAwaits = count(src, /awaitVrtFonts\(/);
      return {
        spec,
        gotos: gotos.length,
        pins: callPins.length,
        awaits: callAwaits.length,
        shots: count(src, /toHaveScreenshot\(/).length,
        firstPinBeforeFirstGoto:
          callPins.length > 0 && gotos.length > 0 && callPins[0] < gotos[0],
      };
    });
}

describe('VRT specs pin the bundled fonts before navigating', () => {
  const facts = specFacts();

  it('the scan sees the suite at all (instrument control)', () => {
    // A drifted regex returns a clean, plausible "nothing to check" and this
    // whole file goes green while enforcing nothing.
    expect(facts.length, 'no *.spec.ts found under e2e/vrt').toBeGreaterThan(20);
    expect(
      facts.filter((f) => f.shots > 0).length,
      'no VRT spec appears to take a screenshot — the toHaveScreenshot scan is broken',
    ).toBeGreaterThan(15);
    expect(
      facts.filter((f) => f.pins > 0).length,
      'no VRT spec appears to call pinVrtFonts — the pin scan is broken',
    ).toBeGreaterThan(15);
  });

  it('every screenshot-taking spec pins fonts, once per navigation', () => {
    const bad = facts
      .filter((f) => f.shots > 0 || !NO_CAPTURE_PROBES.includes(f.spec))
      .filter((f) => f.gotos > 0)
      .filter((f) => f.pins < f.gotos || f.awaits < f.gotos)
      .map(
        (f) =>
          `${f.spec}: ${f.gotos} page.goto() but ${f.pins} pinVrtFonts() / ${f.awaits} ` +
          `awaitVrtFonts() (${f.shots} screenshot site(s))`,
      );
    expect(
      bad,
      'VRT spec(s) that navigate without pinning the bundled fonts. On the ubuntu runner the ' +
        'generic `system-ui` / `ui-monospace` stacks are resolved by fontconfig to whatever face ' +
        'is installed, and that choice is not stable run-to-run — the same commit renders ' +
        'DIFFERENT text metrics, which Playwright reports as a DIMENSION mismatch (hard fail, ' +
        'no tolerance applies) or as a whole-image text diff. Add ' +
        "`await pinVrtFonts(page)` BEFORE page.goto (it installs an addInitScript, so " +
        'post-navigation is too late) and `await awaitVrtFonts(page)` after load. ' +
        'See e2e/vrt/_fonts.ts.',
    ).toEqual([]);
  });

  it('the pin happens BEFORE the first navigation, not after', () => {
    // `pinVrtFonts` works via `page.addInitScript`, which only affects
    // navigations that happen AFTER it is installed. Calling it post-`goto`
    // type-checks, runs, logs nothing — and pins nothing for the page under
    // test. Counting calls cannot see that; ordering can.
    const bad = facts
      .filter((f) => f.gotos > 0 && f.pins > 0 && !f.firstPinBeforeFirstGoto)
      .map((f) => f.spec);
    expect(
      bad,
      'VRT spec(s) whose first pinVrtFonts() call comes AFTER the first page.goto(). ' +
        'addInitScript only applies to subsequent navigations, so the pin is a no-op for the ' +
        'page being captured.',
    ).toEqual([]);
  });

  it('the no-capture exemption list is exactly the specs that capture nothing', () => {
    // An exemption that outlives its reason is how a gate quietly shrinks. If a
    // probe spec starts taking screenshots, it must leave this list.
    const stillProbes = NO_CAPTURE_PROBES.filter((s) => {
      const f = facts.find((x) => x.spec === s);
      return f && f.shots === 0;
    });
    expect(
      stillProbes,
      `NO_CAPTURE_PROBES entries that now capture screenshots (or no longer exist): they must ` +
        `pin fonts like every other capturing spec.`,
    ).toEqual([...NO_CAPTURE_PROBES]);
  });
});
