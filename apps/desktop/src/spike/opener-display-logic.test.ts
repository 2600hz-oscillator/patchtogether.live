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
  compositeAdvanced,
  isOnDisplay,
  motionAdvanced,
  validSample,
  type PixelSample,
  counterColor,
  displayContaining,
  intersectionArea,
  PATTERN,
  pickTargetDisplay,
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

test('popupBoundsOn: centered inside the target work area, including small displays', () => {
  const b = popupBoundsOn(EXTERNAL);
  const area = EXTERNAL.workArea!;
  assert.ok(b.x >= area.x && b.y >= area.y);
  assert.ok(b.x + b.width <= area.x + area.width);
  assert.ok(b.y + b.height <= area.y + area.height);
  // 60% of each dimension.
  assert.equal(b.width, Math.round(area.width * 0.6));
  assert.equal(b.height, Math.round(area.height * 0.6));
  // A small display must not produce an off-screen window.
  const tiny = popupBoundsOn({ id: 9, bounds: { x: 0, y: 0, width: 100, height: 80 } });
  assert.equal(tiny.width, 100);
  assert.equal(tiny.height, 80);
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
  assert.equal(approxColor([255, 0, 255, 255], PATTERN.background), true);
  assert.equal(approxColor([240, 12, 246, 255], PATTERN.background), true); // rounding absorbed
  assert.equal(approxColor([0, 0, 0, 255], PATTERN.background), false); // the captureStream failure mode
  assert.equal(approxColor([255, 255, 255, 255], PATTERN.background), false); // white ≠ magenta
});

test('counterColor encodes byte boundaries and wraps only after 65536 frames', () => {
  assert.deepEqual(counterColor(1), [1, 0, 128]);
  assert.deepEqual(counterColor(255), [255, 0, 128]);
  assert.deepEqual(counterColor(256), [0, 1, 128]);
  assert.deepEqual(counterColor(65535), [255, 255, 128]);
  assert.deepEqual(counterColor(65536), [0, 0, 128]);
});

// ── verdict ────────────────────────────────────────────────────────────────

function steps(status: (id: string) => StepResult['status']): StepResult[] {
  return STEP_ORDER.map((id) => ({ id, status: status(id), detail: id }));
}

test('verdict real mode: all steps PASS → exit 0', () => {
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

test('verdict dry-run: DRY displays/placement/operator acceptable, wiring must PASS', () => {
  const good = verdict(
    steps((id) => (id === 'displays' || id === 'placement' || id === 'operator' ? 'DRY' : 'PASS')),
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


test('target selection rejects mirror rectangles, invalid IDs, and absent requested targets', () => {
  const mirror = { ...EXTERNAL, bounds: { ...PRIMARY.bounds } };
  assert.equal(pickTargetDisplay([PRIMARY, mirror], PRIMARY.id), null);
  assert.equal(pickTargetDisplay([PRIMARY, { ...EXTERNAL, id: -10 }], PRIMARY.id), null);
  assert.equal(pickTargetDisplay([PRIMARY, { ...EXTERNAL, id: -1 }], PRIMARY.id), null);
  assert.equal(pickTargetDisplay([PRIMARY, { ...EXTERNAL, detected: false }], PRIMARY.id), null);
  const left = { ...EXTERNAL, id: 3, bounds: { x: -1920, y: -200, width: 1920, height: 1080 } };
  assert.equal(pickTargetDisplay([PRIMARY, EXTERNAL, left], PRIMARY.id, 3)?.id, 3);
  assert.equal(pickTargetDisplay([PRIMARY, EXTERNAL], PRIMARY.id, 3), null);
});

test('placement rejects majority-only matches and mostly off-screen rectangles', () => {
  assert.equal(isOnDisplay(popupBoundsOn(EXTERNAL), EXTERNAL), true);
  assert.equal(isOnDisplay({ x: 1720, y: 100, width: 100, height: 100 }, EXTERNAL), false);
  assert.equal(isOnDisplay({ x: 3630, y: 100, width: 100, height: 100 }, EXTERNAL), false);
});

function sample(painted: number): PixelSample {
  return { painted, counter: [...counterColor(painted), 255], background: [255, 0, 255, 255], w: 1000, h: 800 };
}

test('motion requires advancing pixels tied to the exact same-turn count', () => {
  assert.equal(motionAdvanced([sample(5), sample(9)]), true);
  assert.equal(motionAdvanced([sample(65534), sample(65540)]), true);
  assert.equal(motionAdvanced([]), false);
  assert.equal(motionAdvanced([sample(5)]), false);
  assert.equal(motionAdvanced([sample(5), sample(5)]), false);
  assert.equal(motionAdvanced([sample(9), sample(5)]), false);
  assert.equal(motionAdvanced([sample(5), { ...sample(9), counter: sample(8).counter }]), false);
});

test('blank, wrong-color and corrupted later samples cannot count as motion', () => {
  for (const invalid of [
    { ...sample(9), background: [0, 0, 0, 255], counter: [0, 0, 0, 255] },
    { ...sample(9), background: [255, 255, 255, 255] },
    { ...sample(9), counter: [255, 255, 255, 255] },
    { ...sample(9), counter: [NaN, 0, 128, 255] },
  ]) {
    assert.equal(validSample(invalid), false);
    assert.equal(motionAdvanced([sample(5), invalid]), false);
  }
  assert.equal(approxColor([NaN, 0, NaN], PATTERN.background), false);
  assert.equal(approxColor([], []), false);
});

test('real verdict requires physical confirmation, even when all automatic steps pass', () => {
  for (const missing of ['operator', 'composited']) {
    assert.equal(verdict(steps(() => 'PASS').filter((s) => s.id !== missing), { dryRun: false }).ok, false);
  }
  assert.equal(verdict(steps((id) => id === 'operator' ? 'DRY' : 'PASS'), { dryRun: false }).ok, false);
});

test('harness errors and ambiguous duplicate results cannot emit a passing verdict', () => {
  const good = steps(() => 'PASS');
  const error = verdict(good, { dryRun: true, error: 'capture failed' });
  assert.equal(error.exitCode, 1);
  assert.ok(error.lines.every((line) => !line.includes('DRY-RUN OK')));
  assert.equal(verdict([...good, good[0]!], { dryRun: false }).ok, false);
});


test('page captures must show advancing encoded frames, including counter wrap', () => {
  assert.equal(compositeAdvanced(counterColor(9), counterColor(20)), true);
  assert.equal(compositeAdvanced(counterColor(65530), counterColor(65540)), true);
  assert.equal(compositeAdvanced(counterColor(9), counterColor(9)), false);
  assert.equal(compositeAdvanced(counterColor(20), counterColor(9)), false);
  assert.equal(compositeAdvanced(counterColor(9), [0, 0, 0]), false);
  assert.equal(compositeAdvanced(counterColor(9), [255, 255, 255]), false);
});
