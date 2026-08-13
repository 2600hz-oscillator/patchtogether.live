// scripts/present-shell-features-contract.test.ts
//
// THE PRESENT-WINDOW `features` STRING IS A TWO-SIDED CONTRACT, AND UNTIL NOW
// EACH SIDE ONLY TESTED ITSELF.
//
// The web app emits it (packages/web/src/lib/ui/modules/present-window.ts →
// `computePopupFeatures`, covered by present-window.test.ts) and the Electron
// kiosk shell parses it (packages/present-shell/parse-features.cjs, covered by
// parse-features.test.cjs) to decide where each projector's borderless window
// is placed. Both suites assert against HAND-TYPED strings, so they agree with
// their author, not with each other: rename a key in the emitter and every
// test on both sides stays green while every present window silently collapses
// to "no rect → fullscreen on the current display" — on the operator's laptop,
// during a show.
//
// Neither package can host this test. The shell is deliberately NOT an npm
// workspace (see scripts/package-workspace-membership.test.ts), and the web
// suite must not reach into a package outside its own graph. scripts/ is the
// one lane that sees both, and it runs inside `task test` — the required unit
// lane — so this is the only place the seam can be gated at all.
//
// ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
//  · It gates the STRING, not Electron. `main.cjs` turning the parsed rect into
//    a BrowserWindow needs a real display and is out of scope here.
//  · It reads the emitter's PURE function. If the caller ever stopped passing
//    the emitted string to window.open, this stays green.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { computePopupFeatures } from '../packages/web/src/lib/ui/modules/present-window';

const require = createRequire(import.meta.url);
const { boundsFromFeatures, parseFeatures } = require('../packages/present-shell/parse-features.cjs') as {
  boundsFromFeatures: (features: string) => { x: number; y: number; width: number; height: number } | null;
  parseFeatures: (features: string) => { left: number; top: number; width: number; height: number };
};

/** Screen rects the emitter can be handed in the field, each named so a failure
 *  says WHICH geometry broke. Includes the cases that distinguish a real parse
 *  from a lucky one: a display left of / above the primary (negative origin),
 *  fractional device-pixel-ratio bounds, and a degenerate rect. */
const RECTS: ReadonlyArray<{ what: string; rect: { left: number; top: number; width: number; height: number } }> = [
  { what: 'primary display at the origin', rect: { left: 0, top: 0, width: 1920, height: 1080 } },
  { what: 'projector to the right of the primary', rect: { left: 1920, top: 0, width: 1280, height: 720 } },
  { what: 'projector LEFT of the primary (negative x)', rect: { left: -1920, top: 0, width: 1920, height: 1080 } },
  { what: 'projector ABOVE the primary (negative y)', rect: { left: 0, top: -1080, width: 1920, height: 1080 } },
  { what: 'fractional bounds from a scaled display', rect: { left: 1706.5, top: 0.4, width: 1280.6, height: 720.2 } },
];

describe('present features string: the web emitter and the shell parser agree', () => {
  it('every rect the web app can emit round-trips to the same rect in the shell', () => {
    const wrong = RECTS.flatMap(({ what, rect }) => {
      const features = computePopupFeatures(rect);
      const got = boundsFromFeatures(features);
      const want = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      return JSON.stringify(got) === JSON.stringify(want)
        ? []
        : [`${what}: emitted '${features}' → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];
    });
    expect(
      wrong,
      'packages/web computePopupFeatures and packages/present-shell parse-features.cjs have drifted. ' +
        'The shell places every projector window from this string; a mismatch means each present ' +
        'window silently falls back to fullscreen on the CURRENT display. Change both sides together.',
    ).toEqual([]);
  });

  it('a null rect still yields a usable rect, not a fallback', () => {
    // The emitter substitutes DEFAULT_POPUP for a null/degenerate rect, so the
    // shell must never see a sizeless string from the real caller. If this ever
    // returns null, the shell's "no rect" branch becomes reachable in normal
    // operation and every window lands on the laptop.
    expect(boundsFromFeatures(computePopupFeatures(null))).not.toBeNull();
    expect(boundsFromFeatures(computePopupFeatures({ left: 0, top: 0, width: 0, height: 0 }))).not.toBeNull();
  });

  it('NEGATIVE CONTROL: the round-trip fails when either side renames a key', () => {
    // Proves the assertion above is sensitive to the drift it claims to catch —
    // without this, a parser that returned the expected rect for ANY input
    // would pass every line above. Perturbs the emitted string exactly as a
    // rename would, and drives the SAME parser the real assertion uses.
    const features = computePopupFeatures({ left: 1920, top: 0, width: 1280, height: 720 });
    const renamed = features.replace('left=', 'x=').replace('top=', 'y=');
    const got = boundsFromFeatures(renamed);
    expect(got, 'a renamed key must NOT silently round-trip').not.toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 720,
    });
    // And a dropped size must degrade to the shell's documented "no rect" branch
    // rather than to a bogus 0×0 window.
    expect(boundsFromFeatures(features.replace(/,width=\d+,height=\d+/, ''))).toBeNull();
    // The emitter's key names, asserted against the parser's own key set rather
    // than a re-typed literal: if either side renames, this list stops matching.
    expect(Object.keys(parseFeatures(features)).every((k) => features.includes(`${k}=`))).toBe(true);
  });
});
