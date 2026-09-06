// Unit tests for the spike's PURE logic — the half of the harness that CAN be
// proven off the owner's hardware. `node --test` (built into Node, no new
// deps) over the compiled dist output: `npm run spike:unit`.
//
// Deliberately NOT under e2e/ — apps/desktop/playwright.config.ts globs every
// e2e/*.spec.ts into the desktop:e2e lane, and this file must not join a lane
// (owner ruling: no new gates without discussion; this runs inside
// `task desktop:spike` and by hand).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  approxColor,
  counterColor,
  displayContaining,
  intersectionArea,
  isNonBlack,
  PATTERN,
  pickTargetDisplay,
  pixelsDiffer,
  popupBoundsOn,
  popupFeatures,
  STEP_ORDER,
  verdict,
  type DisplayLike,
  type StepResult,
} from './opener-display-logic';

// A believable dual-monitor map: retina laptop + 1080p external to its right.
const PRIMARY: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 25, width: 1728, height: 1092 },
};
const EXTERNAL: DisplayLike = {
  id: 2,
  bounds: { x: 1728, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1728, y: 25, width: 1920, height: 1055 },
};

test('pickTargetDisplay: the non-primary display, wherever it sits in the list', () => {
  assert.equal(pickTargetDisplay([PRIMARY, EXTERNAL], PRIMARY.id)?.id, EXTERNAL.id);
  assert.equal(pickTargetDisplay([EXTERNAL, PRIMARY], PRIMARY.id)?.id, EXTERNAL.id);
  assert.equal(pickTargetDisplay([PRIMARY], PRIMARY.id), null);
  assert.equal(pickTargetDisplay([], PRIMARY.id), null);
});

test('popupBoundsOn: centered inside the target work area, floored size', () => {
  const b = popupBoundsOn(EXTERNAL);
  const area = EXTERNAL.workArea!;
  assert.ok(b.x >= area.x && b.y >= area.y);
  assert.ok(b.x + b.width <= area.x + area.width);
  assert.ok(b.y + b.height <= area.y + area.height);
  // 60% of each dimension.
  assert.equal(b.width, Math.round(area.width * 0.6));
  assert.equal(b.height, Math.round(area.height * 0.6));
  // Floors hold on an absurdly small display.
  const tiny = popupBoundsOn({ id: 9, bounds: { x: 0, y: 0, width: 100, height: 80 } });
  assert.equal(tiny.width, 320);
  assert.equal(tiny.height, 240);
});

test('popupFeatures: the present-window popup shape, exact', () => {
  assert.equal(
    popupFeatures({ x: 10, y: 20, width: 300, height: 200 }),
    'popup,left=10,top=20,width=300,height=200',
  );
});

test('intersectionArea: overlap, disjoint, touching edges', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(intersectionArea(a, { x: 50, y: 50, width: 100, height: 100 }), 2500);
  assert.equal(intersectionArea(a, { x: 200, y: 0, width: 10, height: 10 }), 0);
  // Sharing only an edge is zero area, not a match.
  assert.equal(intersectionArea(a, { x: 100, y: 0, width: 50, height: 100 }), 0);
});

test('displayContaining: majority display wins; fully off-screen is null', () => {
  const all = [PRIMARY, EXTERNAL];
  const onExternal = popupBoundsOn(EXTERNAL);
  assert.equal(displayContaining(all, onExternal)?.id, EXTERNAL.id);
  // A window straddling the seam but mostly on the primary belongs to the primary.
  const straddle = { x: 1728 - 600, y: 100, width: 800, height: 400 };
  assert.equal(displayContaining(all, straddle)?.id, PRIMARY.id);
  // Fully off every display: a placement FAILURE, not a nearest-neighbor guess.
  assert.equal(displayContaining(all, { x: 99_999, y: 99_999, width: 100, height: 100 }), null);
});

test('pixel predicates: black stays black, magenta reads magenta', () => {
  assert.equal(isNonBlack([0, 0, 0, 255]), false);
  assert.equal(isNonBlack([10, 10, 10, 255]), false); // near-black noise is still black
  assert.equal(isNonBlack([0, 0, 200, 255]), true);
  assert.equal(approxColor([255, 0, 255, 255], PATTERN.background), true);
  assert.equal(approxColor([240, 12, 246, 255], PATTERN.background), true); // rounding absorbed
  assert.equal(approxColor([0, 0, 0, 255], PATTERN.background), false); // the captureStream failure mode
  assert.equal(approxColor([255, 255, 255, 255], PATTERN.background), false); // white ≠ magenta
});

test('counterColor + pixelsDiffer: any two samples ≥1 frame apart differ, wrap included', () => {
  // The exact pairs the harness will compare: painted f vs f+k, small k.
  for (const [f, k] of [
    [1, 3],
    [42, 7],
    [254, 3], // red wraps 254→1; green picks up the carry
    [255, 1],
    [511, 2],
  ] as const) {
    const a = [...counterColor(f), 255];
    const b = [...counterColor(f + k), 255];
    assert.ok(pixelsDiffer(a, b), `frames ${f} vs ${f + k} must differ`);
  }
  const same = [...counterColor(7), 255];
  assert.equal(pixelsDiffer(same, [...counterColor(7), 255]), false);
});

// ── verdict ────────────────────────────────────────────────────────────────

function steps(status: (id: string) => StepResult['status']): StepResult[] {
  return STEP_ORDER.map((id) => ({ id, status: status(id), detail: id }));
}

test('verdict real mode: all five PASS → exit 0', () => {
  const v = verdict(steps(() => 'PASS'), { dryRun: false });
  assert.equal(v.ok, true);
  assert.equal(v.exitCode, 0);
  assert.match(v.lines[v.lines.length - 1]!, /SPIKE PASS/);
});

test('verdict real mode: one FAIL fails; DRY can never pass as real', () => {
  for (const bad of ['FAIL', 'DRY', 'NOT-RUN'] as const) {
    const v = verdict(
      steps((id) => (id === 'blitPixels' ? bad : 'PASS')),
      { dryRun: false },
    );
    assert.equal(v.ok, false, `status ${bad} must fail real mode`);
    assert.equal(v.exitCode, 1);
  }
});

test('verdict real mode: a missing step counts as NOT-RUN and fails', () => {
  const v = verdict([{ id: 'displays', status: 'PASS', detail: 'two displays' }], { dryRun: false });
  assert.equal(v.ok, false);
  // Every step still gets a line — no silent omissions.
  assert.equal(v.lines.length, STEP_ORDER.length + 1);
});

test('verdict dry-run: DRY displays/placement acceptable, wiring must PASS', () => {
  const good = verdict(
    steps((id) => (id === 'displays' || id === 'placement' ? 'DRY' : 'PASS')),
    { dryRun: true },
  );
  assert.equal(good.ok, true);
  assert.equal(good.exitCode, 0);
  assert.match(good.lines[good.lines.length - 1]!, /NOT the spike result/);

  const bad = verdict(
    steps((id) => (id === 'domAccess' ? 'FAIL' : id === 'displays' ? 'DRY' : 'PASS')),
    { dryRun: true },
  );
  assert.equal(bad.ok, false);
});

test('verdict dry-run: DRY on a WIRING step still fails — no vacuous green', () => {
  const v = verdict(steps(() => 'DRY'), { dryRun: true });
  assert.equal(v.ok, false);
});
