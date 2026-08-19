// packages/web/src/lib/ui/modules/freezeframe-screen-source.test.ts
//
// SCREEN OFF MUST SKIP THE BLIT, NEVER THE LOOP — a source-level gate, because
// no runtime gate in this repo can see the difference.
//
// THE BUG CLASS (#1720/#1721). The tempting implementation of a preview
// collapse is to stop drawing: `if (collapsed) return;`. It looks identical
// from the outside while the screen is off — the picture is hidden either way —
// and it is wrong in one specific moment, the moment the player switches the
// screen back ON. A loop that stopped re-arming does not resume, so the canvas
// paints whatever bytes it held when it stopped, i.e. a STALE FRAME, or black.
//
// ⚠ WHY THIS IS A SOURCE GREP AND NOT AN ASSERTION ON BEHAVIOUR. The e2e
// (`freezeframe-screen-toggle.spec.ts`) can see that a picture RETURNS; it
// cannot see whether it returned because the loop never stopped or because
// something else forced a repaint, and with nothing patched to `video_in` a
// live frame and a stale frame can be the same pixels. The first draft of that
// spec tried to close this with a `window.__videoEngine.hasNode` probe — a hook
// that DOES NOT EXIST, so it returned null, skipped its assertion and passed
// green while measuring nothing. This file is the replacement, and it is
// deny-by-default: it reads the shipped source and requires the collapsed
// branch to re-arm.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(HERE, 'FreezeframeCard.svelte');
const SRC = readFileSync(CARD, 'utf8');

/** The collapsed guard inside `draw()`, whatever whitespace it is written in. */
const COLLAPSED_GUARD =
  /if\s*\(\s*previewCollapsed\s*\)\s*\{([^}]*)\}/;

describe('freezeframe SCREEN OFF — the draw loop keeps running', () => {
  it('the card HAS a collapsed guard inside its draw loop', () => {
    // Anchored: if the toggle is ever reimplemented without this branch, the
    // test that follows would be checking a guard that no longer exists, so it
    // must fail LOUDLY rather than pass on an empty match.
    expect(
      COLLAPSED_GUARD.test(SRC),
      'FreezeframeCard.draw() must branch on previewCollapsed — the SCREEN OFF fast path',
    ).toBe(true);
  });

  it('that guard RE-ARMS the rAF before returning', () => {
    const body = SRC.match(COLLAPSED_GUARD)![1]!;
    expect(
      /requestAnimationFrame\s*\(\s*draw\s*\)/.test(body),
      'SCREEN OFF must skip the BLIT, not the LOOP: the collapsed branch has to ' +
        're-arm requestAnimationFrame(draw) before returning, or switching the ' +
        'screen back on shows a stale frame instead of the live picture ' +
        `(#1720/#1721). Branch body was: ${JSON.stringify(body.trim())}`,
    ).toBe(true);
  });

  it('NEGATIVE CONTROL — the gate rejects the tempting wrong implementation', () => {
    // Proves the assertion above can FAIL, on the exact shape it exists to
    // refuse. Without this leg a regex that matched nothing would look green.
    const wrong = 'function draw() {\n  if (previewCollapsed) { return; }\n}';
    const body = wrong.match(COLLAPSED_GUARD)![1]!;
    expect(/requestAnimationFrame\s*\(\s*draw\s*\)/.test(body)).toBe(false);
  });

  it('the lifecycle hooks are untouched by the toggle', () => {
    // The other way to break this: cancel the frame on collapse and restart it
    // on expand. That reintroduces the stale-frame window at the seam and adds
    // a race; the toggle must not appear in a cancel path at all.
    const cancels = [...SRC.matchAll(/cancelAnimationFrame\s*\([^)]*\)/g)].map((m) => m[0]);
    expect(cancels.length, 'the card cancels its rAF exactly once, in onDestroy').toBe(1);
    const onDestroyIdx = SRC.indexOf('onDestroy');
    const cancelIdx = SRC.indexOf('cancelAnimationFrame');
    expect(cancelIdx, 'the only cancelAnimationFrame is inside onDestroy').toBeGreaterThan(onDestroyIdx);
  });

  it('the persisted flag lives on node.data, so it survives a tab switch', () => {
    // The owner's stated floor, guarded at the source too: a `$state` boolean
    // would satisfy every DOM assertion and silently lose the setting on
    // remount. The e2e asserts the VALUE persists; this asserts the MECHANISM.
    expect(/data\?\.previewCollapsed/.test(SRC), 'reads the flag off node.data').toBe(true);
    expect(
      /mutateNode\(\s*id\s*,/.test(SRC),
      'writes it through mutateNode, so it syncs and persists',
    ).toBe(true);
  });
});
