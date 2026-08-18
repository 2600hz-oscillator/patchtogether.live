// packages/web/src/lib/ui/modules/detached-display.test.ts
//
// THE DETACHED DISPLAY's pure model (#1821). No DOM, no Yjs — every rule the
// component obeys is a function here, so the constraints the owner blessed are
// pinned rather than described.

import { describe, it, expect } from 'vitest';
import {
  DETACHABLE_DISPLAYS,
  DETACHED_DEFAULT_H,
  DETACHED_DEFAULT_W,
  DETACHED_KEEP_VISIBLE,
  DETACHED_KEYS,
  DETACHED_MIN_H,
  DETACHED_MIN_W,
  REATTACH_CLEARS,
  clampDetachedRect,
  detachPatch,
  placeDetached,
  detachedRect,
  isDetached,
  supportsDetachedDisplay,
} from './detached-display';
import type { ModuleNode } from '$lib/graph/types';
// Side-effect import: populates the video registry so the scope anchor below
// reads the LIVE roster.
import '$lib/video/modules';
import { listVideoModuleDefs, getVideoModuleDef } from '$lib/video/module-registry';

const VIEWPORT = { width: 1600, height: 900 };

function node(data?: Record<string, unknown>): ModuleNode {
  return { id: 'n', type: 'videoOut', domain: 'video', position: { x: 0, y: 0 }, params: {}, data };
}

// ---- the scope is anchored to the live registry ---------------------------

describe('the SCOPE is declared, the CAPABILITY is derived', () => {
  it('every DETACHABLE_DISPLAYS entry names a LIVE video def that publishes a video output', () => {
    // Anchored BOTH ways: a name with no def is red, and a name whose def has
    // no video output is red — because the panel blits that output's texture,
    // so without one the feature is a black rectangle.
    const live = new Map(listVideoModuleDefs().map((d) => [d.type, d]));
    const broken = DETACHABLE_DISPLAYS.map((entry) => {
      const def = live.get(entry.type);
      if (!def) return `${entry.type}: names no registered video def`;
      if (!supportsDetachedDisplay(entry.type, def)) {
        return `${entry.type}: registered, but no longer publishes a video output`;
      }
      return null;
    }).filter((x): x is string => x !== null);
    expect(broken, 'DETACHABLE_DISPLAYS entries that no longer resolve').toEqual([]);
  });

  it('every entry carries a real WHY', () => {
    const thin = DETACHABLE_DISPLAYS.filter((e) => e.why.trim().length < 40).map((e) => e.type);
    expect(thin).toEqual([]);
  });

  it('DENIES BY DEFAULT — an unscoped video module with a video output cannot detach', () => {
    // The negative control for the scope half. `backdraft` publishes a video
    // output and is a promoted video face, so it satisfies the DERIVED test and
    // is refused purely because the owner scoped this to the OUTPUT monitor.
    const bd = getVideoModuleDef('backdraft');
    expect(bd, 'backdraft is registered (fixture sanity)').toBeDefined();
    expect(supportsDetachedDisplay('backdraft', bd)).toBe(false);
    expect(supportsDetachedDisplay('videoOut', getVideoModuleDef('videoOut'))).toBe(true);
  });

  it('a scoped type with NO def, or a def with no video output, is refused', () => {
    expect(supportsDetachedDisplay('videoOut', undefined)).toBe(false);
    expect(supportsDetachedDisplay('videoOut', { type: 'videoOut', inputs: [], outputs: [] })).toBe(false);
    expect(
      supportsDetachedDisplay('videoOut', {
        type: 'videoOut',
        inputs: [],
        outputs: [{ id: 'gate', type: 'gate' }],
      }),
      'a non-video output is not a picture',
    ).toBe(false);
  });
});

// ---- the flag -------------------------------------------------------------

describe('isDetached — absent means ATTACHED', () => {
  it('an existing rack with no flag is attached', () => {
    expect(isDetached(node())).toBe(false);
    expect(isDetached(node({}))).toBe(false);
    expect(isDetached(undefined)).toBe(false);
  });

  it('only the literal `true` detaches (a stale string does not)', () => {
    expect(isDetached(node({ [DETACHED_KEYS.on]: true }))).toBe(true);
    expect(isDetached(node({ [DETACHED_KEYS.on]: false }))).toBe(false);
    expect(isDetached(node({ [DETACHED_KEYS.on]: 'true' }))).toBe(false);
  });
});

// ---- geometry: the constraints, each named --------------------------------

describe('clampDetachedRect — the blessed constraints', () => {
  it('a fresh detach centres a default-sized panel', () => {
    const r = clampDetachedRect({}, VIEWPORT);
    expect(r.w).toBe(DETACHED_DEFAULT_W);
    expect(r.h).toBe(DETACHED_DEFAULT_H);
    expect(r.x).toBe((VIEWPORT.width - DETACHED_DEFAULT_W) / 2);
    expect(r.y).toBe((VIEWPORT.height - DETACHED_DEFAULT_H) / 2);
  });

  it('MINIMUM SIZE: a panel cannot be resized into a handle-less dot', () => {
    const r = clampDetachedRect({ x: 10, y: 10, w: 1, h: 1 }, VIEWPORT);
    expect(r.w).toBe(DETACHED_MIN_W);
    expect(r.h).toBe(DETACHED_MIN_H);
  });

  it('never larger than the window — the grip must stay reachable', () => {
    const r = clampDetachedRect({ x: 0, y: 0, w: 99_999, h: 99_999 }, VIEWPORT);
    expect(r.w).toBe(VIEWPORT.width);
    expect(r.h).toBe(VIEWPORT.height);
  });

  it('KEEP_VISIBLE: dragged off the right/bottom, enough stays on screen to drag it back', () => {
    const r = clampDetachedRect({ x: 99_999, y: 99_999, w: 480, h: 360 }, VIEWPORT);
    expect(r.x).toBe(VIEWPORT.width - DETACHED_KEEP_VISIBLE);
    expect(r.y).toBe(VIEWPORT.height - DETACHED_KEEP_VISIBLE);
    // …and the panel is still partly on screen on both axes.
    expect(r.x).toBeLessThan(VIEWPORT.width);
    expect(r.y).toBeLessThan(VIEWPORT.height);
  });

  it('KEEP_VISIBLE: dragged off the left, the same amount stays; the TOP is hard-stopped', () => {
    const r = clampDetachedRect({ x: -99_999, y: -99_999, w: 480, h: 360 }, VIEWPORT);
    expect(r.x).toBe(DETACHED_KEEP_VISIBLE - 480);
    // ⚠ The top is clamped to 0, not to KEEP_VISIBLE − h: the header IS the drag
    // handle, so a panel whose header is above the viewport can never be moved.
    expect(r.y).toBe(0);
  });

  it('TOTALITY: NaN / Infinity / a hostile viewport resolve to defaults instead of throwing', () => {
    // This runs on every render and inside a pointermove — a throw here takes
    // the canvas down mid-drag.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = clampDetachedRect({ x: bad, y: bad, w: bad, h: bad }, VIEWPORT);
      expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
      expect(r.w).toBeGreaterThanOrEqual(DETACHED_MIN_W);
      expect(r.h).toBeGreaterThanOrEqual(DETACHED_MIN_H);
    }
    const z = clampDetachedRect({ x: 5, y: 5, w: 480, h: 360 }, { width: 0, height: 0 });
    expect(Number.isFinite(z.x) && Number.isFinite(z.y) && z.w > 0 && z.h > 0).toBe(true);
  });

  it('an ALREADY-VALID rect is returned unchanged (the clamp is not a mangle)', () => {
    const good = { x: 100, y: 120, w: 640, h: 480 };
    expect(clampDetachedRect(good, VIEWPORT)).toEqual(good);
  });
});

describe('detachedRect — reads the node, clamps the result', () => {
  it('reads the persisted geometry back', () => {
    const n = node({
      [DETACHED_KEYS.on]: true,
      [DETACHED_KEYS.x]: 40,
      [DETACHED_KEYS.y]: 60,
      [DETACHED_KEYS.w]: 800,
      [DETACHED_KEYS.h]: 600,
    });
    expect(detachedRect(n, VIEWPORT)).toEqual({ x: 40, y: 60, w: 800, h: 600 });
  });

  it('a NON-numeric persisted value (a peer wrote junk) falls back rather than propagating', () => {
    const n = node({ [DETACHED_KEYS.x]: 'left', [DETACHED_KEYS.w]: null });
    const r = detachedRect(n, VIEWPORT);
    expect(r.w).toBe(DETACHED_DEFAULT_W);
    expect(Number.isFinite(r.x)).toBe(true);
  });

  it('geometry saved on a BIG screen is clamped when reopened on a small one', () => {
    const n = node({ [DETACHED_KEYS.x]: 1500, [DETACHED_KEYS.y]: 800, [DETACHED_KEYS.w]: 900, [DETACHED_KEYS.h]: 700 });
    const small = { width: 800, height: 600 };
    const r = detachedRect(n, small);
    expect(r.w).toBeLessThanOrEqual(small.width);
    expect(r.h).toBeLessThanOrEqual(small.height);
    expect(r.x).toBeLessThanOrEqual(small.width - DETACHED_KEEP_VISIBLE);
    expect(r.y).toBeLessThanOrEqual(small.height - DETACHED_KEEP_VISIBLE);
  });
});


describe('placeDetached — a fresh panel must not cover the card it came from', () => {
  it('centres when there is nothing to avoid', () => {
    expect(placeDetached(VIEWPORT)).toEqual(clampDetachedRect({}, VIEWPORT));
  });

  it('centres when the card does not overlap the centred position', () => {
    const farLeft = { x: 0, y: 0, w: 200, h: 200 };
    expect(placeDetached(VIEWPORT, farLeft)).toEqual(clampDetachedRect({}, VIEWPORT));
  });

  it('SLIDES CLEAR when the card sits where the panel would open', () => {
    // ⚠ The regression this exists for: the panel opened dead-centre, a
    // just-revealed card is dead-centre, and the panel's canvas then swallowed
    // the right-click aimed at the card — blocking one of the two re-attach
    // entry points the owner asked for.
    const centred = clampDetachedRect({}, VIEWPORT);
    const card = { x: centred.x, y: centred.y, w: 360, h: 360 };
    const placed = placeDetached(VIEWPORT, card);
    const clear =
      placed.x >= card.x + card.w || card.x >= placed.x + placed.w ||
      placed.y >= card.y + card.h || card.y >= placed.y + placed.h;
    expect(clear, `placed ${JSON.stringify(placed)} still overlaps ${JSON.stringify(card)}`).toBe(true);
  });

  it('prefers the side with more room', () => {
    // Card hard against the left edge ⇒ the panel goes right.
    const leftCard = { x: 0, y: 300, w: 700, h: 360 };
    expect(placeDetached(VIEWPORT, leftCard).x).toBeGreaterThanOrEqual(leftCard.w);
    // Card hard against the right edge ⇒ the panel goes left.
    const rightCard = { x: VIEWPORT.width - 700, y: 300, w: 700, h: 360 };
    const placed = placeDetached(VIEWPORT, rightCard);
    expect(placed.x + placed.w).toBeLessThanOrEqual(rightCard.x);
  });

  it('stays ON SCREEN whatever it does — placement never defeats the clamp', () => {
    for (const card of [
      { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height },
      { x: -500, y: -500, w: 900, h: 900 },
      { x: VIEWPORT.width - 10, y: 0, w: 2000, h: 2000 },
    ]) {
      const r = placeDetached(VIEWPORT, card);
      expect(r.w).toBeGreaterThanOrEqual(DETACHED_MIN_W);
      expect(r.h).toBeGreaterThanOrEqual(DETACHED_MIN_H);
      expect(r.x).toBeLessThanOrEqual(VIEWPORT.width - DETACHED_KEEP_VISIBLE);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('NEVER opens partly off-screen — a dodge that leaves the title bar unreachable is not a dodge', () => {
    // ⚠ MEASURED: dodging a card near the left edge placed the panel at x = -113,
    // and a pointer cannot grab a title bar at negative screen coordinates — the
    // drag produced exactly zero movement. `clampDetachedRect` allows that
    // position for a USER drag (KEEP_VISIBLE is about leaving a grab strip); an
    // OPENING window has a stricter requirement.
    for (const card of [
      { x: 300, y: 200, w: 360, h: 360 },
      { x: 40, y: 200, w: 360, h: 360 },
      { x: VIEWPORT.width - 400, y: 200, w: 360, h: 360 },
      { x: 0, y: 0, w: 900, h: 700 },
    ]) {
      const r = placeDetached(VIEWPORT, card);
      expect(r.x, `card ${JSON.stringify(card)} → x`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, `card ${JSON.stringify(card)} → right edge`).toBeLessThanOrEqual(VIEWPORT.width);
    }
  });

  it("⚠ THE CI GEOMETRY: a 1280x720 viewport where NEITHER SIDE FITS still does not overlap the click target", () => {
    // ⚠ THIS IS THE LEG THAT WOULD HAVE CAUGHT THE CI FAILURE, and it failed only
    // on CI because the shape is pure geometry. `devices['Desktop Chrome']` is
    // 1280x720; a 480-wide panel cannot clear a 360-wide card near the middle on
    // EITHER side (right needs 832+480 = 1312 > 1280; left needs -32 < 0). The
    // first version rejected both as off-screen and returned the CENTRED rect —
    // the exact collision this function exists to prevent — so the panel covered
    // the card and swallowed the right-click that re-attaches. A wider dev
    // viewport dodged cleanly and hid it for 48 local runs.
    const CI = { width: 1280, height: 720 };
    const card = { x: 460, y: 180, w: 360, h: 360 };
    const r = placeDetached(CI, card);

    // Fully on screen…
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(CI.width);
    expect(r.y + r.h).toBeLessThanOrEqual(CI.height);

    // …and NOT the centred rect, which is what shipped and overlapped.
    expect(r, 'must not fall back to the overlapping centred position').not.toEqual(
      clampDetachedRect({}, CI),
    );

    // The load-bearing property: the CARD'S OWN CENTRE — where a right-click
    // lands — is not covered. That is the user-visible requirement; "zero
    // overlap" is merely the usual way to achieve it.
    const cx = card.x + card.w / 2;
    const cy = card.y + card.h / 2;
    const covers = cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    expect(covers, `panel ${JSON.stringify(r)} covers the card centre (${cx},${cy})`).toBe(false);
  });

  it('the click target stays clear across a sweep of viewports and card positions', () => {
    // A property, not one example: the CI case above is one point in this space,
    // and the first fix passed every point I happened to try locally.
    for (const vp of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      for (const cx0 of [0, 200, 460, 700, vp.width - 380]) {
        const card = { x: cx0, y: 180, w: 360, h: 360 };
        const r = placeDetached(vp, card);
        const cx = card.x + card.w / 2;
        const cy = card.y + card.h / 2;
        const covers = cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
        expect(
          covers,
          `viewport ${vp.width}x${vp.height}, card at ${cx0}: panel ${JSON.stringify(r)} covers the click target`,
        ).toBe(false);
      }
    }
  });

  it('an UNMEASURABLE card falls back to a CORNER, never to the centre', () => {
    // ⚠ The centre is the worst guess when the card cannot be measured, because
    // a just-revealed card is itself centred — so the "unknown" fallback would
    // reinstate the very collision this function exists to prevent, in exactly
    // the conditions where we know least (element gone, or not yet laid out).
    const centred = clampDetachedRect({}, VIEWPORT);
    for (const bad of [
      // ⚠ `undefined` is NOT in this list: it means "no card element at all",
      // which is genuinely nothing to dodge and is asserted to CENTRE above.
      // These are the "the card is there, we could not measure it" cases.
      { x: 100, y: 100, w: 0, h: 0 },
      { x: 100, y: 100, w: NaN, h: 200 },
      { x: 100, y: 100, w: 200, h: -5 },
    ]) {
      const r = placeDetached(VIEWPORT, bad as never);
      expect(r, `unmeasurable card ${JSON.stringify(bad)} must not centre`).not.toEqual(centred);
      // …and still fully on screen.
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(VIEWPORT.width);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('a card covering the WHOLE viewport falls back to centred rather than off-screen', () => {
    // Deliberate: no placement can dodge it, and a draggable panel beats a
    // wedged one.
    const everything = { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height };
    expect(placeDetached(VIEWPORT, everything)).toEqual(clampDetachedRect({}, VIEWPORT));
  });
});

// ---- the two patches ------------------------------------------------------

describe('detach / re-attach are ONE flag apart', () => {
  it('detachPatch writes the flag AND the geometry, so one transaction is one undo', () => {
    const p = detachPatch({ x: 10, y: 20, w: 480, h: 360 });
    expect(p).toEqual({
      [DETACHED_KEYS.on]: true,
      [DETACHED_KEYS.x]: 10,
      [DETACHED_KEYS.y]: 20,
      [DETACHED_KEYS.w]: 480,
      [DETACHED_KEYS.h]: 360,
      fullFrame: false,
    });
  });

  it('detachPatch CLEARS full frame — the mutual exclusion lives in the transition, not the caller', () => {
    // Regression: two of the three detach entry points cleared `fullFrame` and
    // the third did not — and the third was the NODE CONTEXT MENU, which after
    // promotion is the only detach route a rack TILE has. Putting it in the
    // patch makes every caller correct by construction.
    expect(detachPatch({ x: 0, y: 0, w: 480, h: 360 }).fullFrame).toBe(false);
  });

  it('RE-ATTACH clears the FLAG ONLY — the panel comes back where you left it', () => {
    expect(REATTACH_CLEARS).toEqual([DETACHED_KEYS.on]);
    // The geometry keys are deliberately NOT in the clear list; a re-detach
    // should restore the last size/position, like any remembered window.
    for (const k of [DETACHED_KEYS.x, DETACHED_KEYS.y, DETACHED_KEYS.w, DETACHED_KEYS.h]) {
      expect(REATTACH_CLEARS).not.toContain(k);
    }
  });

  it("the flag's own key never collides with the card's existing node.data keys", () => {
    // videoOut already persists `width`/`height` (card resize) and `fullFrame`.
    // A collision would make resizing the card resize the panel.
    const existing = ['width', 'height', 'fullFrame', 'previewCollapsed', 'pinned', 'name'];
    for (const k of Object.values(DETACHED_KEYS)) expect(existing).not.toContain(k);
  });
});
