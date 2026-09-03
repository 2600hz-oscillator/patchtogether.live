// e2e/tests/face-moog956.spec.ts
//
// ═══════ THE 956 RIBBON'S FACE, AND ITS REAL SOURCE CHAIN ═══════
//
// moog956 entered STRICT_FACES on 2026-09-02. Its instrument is ONE POINTER
// STROKE that writes `pos` and raises `gate` together and, on release, drops
// the gate while LEAVING the pitch — so the promotion carries the strip onto
// BOTH of the module's surfaces (the lane `tileBody` and the dock
// `fullViewBody`) with the four params ranked as ordinary cells beneath them.
//
// ⚠ THERE WAS NO e2e FOR THIS MODULE AT ALL BEFORE THIS FILE. The per-port
// sweep exempts it by name ("pitch/gate emitted only while the ribbon is
// touched (no pointer drag in the per-port harness)"), so every automated claim
// about moog956 came from a unit test driving the factory with a mock
// AudioContext. A module whose whole behaviour is a gesture had nothing
// anywhere that performed one.
//
// ── WHY THE SECOND TEST IS AN AUDIBLE CHAIN AND NOT A PARAM READ ────────────
//
// `readParam` after a synthetic `setParam` proves the store round-trips. It
// does not prove the strip is wired, that the press order is right, or that
// either output leaves the module. So the chain here is end to end and nothing
// in it is stubbed:
//
//   moog956.pitch --> analogVco.pitch      (V/oct, 0 V = C4)
//   analogVco.sine --> vca.audio ;  moog956.gate --> vca.cv ;  vca.audio --> SCOPE.ch1
//
// The VCA spawns CLOSED (`base` 0, `cvAmount` 1), so its output IS the module's
// GATE jack made audible — silent at rest, open under a finger — and the
// oscillator's FUNDAMENTAL is the module's PITCH jack made measurable. One
// gesture drives both, which is the point: a chain that only watched the gate
// would pass on a promotion that had silently stopped writing the pitch.
//
// ⚠ FILENAME: `face-moog956.spec.ts` matches none of WEBGL_HEAVY_GLOBS (which
// prefix-match `video-*`, `videobox-*`, `videovarispeed-*`, `toybox-*`,
// `render-worker-*`, `*-render-smoke`), so it runs in the sharded `e2e` matrix
// job. A name colliding with one of those prefixes would remove it from CI
// entirely and look like ordinary bookkeeping.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { pollScopeBandAmp, sampleScopeRms } from '../_helpers/scope-poll';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, and without this line it is the invisible
// 30 s Playwright default (#2291's class). These legs boot the DEFAULT shell —
// WorkflowTopbar, dock rails, pinned singletons — and the second one also boots
// an AudioContext and a Faust oscillator, which on a loaded CI runner exceeds
// 30 s before the first assertion. A bound only costs wall-clock when exceeded,
// so this adds zero to a green run.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** The scope RMS a closed VCA must stay under, and an open one must clear —
 *  the same floor the trails / launchpad real-source-chain specs use. */
const AUDIBLE_FLOOR = 0.03;
/** Full window for a SILENCE half — no early exit, because an assertion of
 *  silence has nothing to exit early on. */
const SILENCE_WINDOW_MS = 400;
/** Cap that BOUNDS a failure on an audible half; the `until*` target is the
 *  gate, and it must name the field the assertion then reads. */
const AUDIBLE_CAP_MS = 6000;

// The def's pitch law, evaluated for THIS rack rather than restated: with the
// default `scale: 2, offset: 0`, `pitch = pos * 2` V/oct and analogVco reads
// 0 V as C4. So the ribbon's far left sounds C4 and its midpoint sounds C5,
// one octave up — two bands far enough apart that neither Goertzel probe can
// read the other's energy.
const C4_HZ = 261.63;
const C5_HZ = 523.25;
/** A pure sine through an open VCA lands the fundamental near its amplitude;
 *  this floor is an order below that and an order above the leakage a
 *  2048-sample window puts in a neighbouring octave. */
const BAND_FLOOR = 0.05;

/** The stored params, read off the patch store — the persisted values the
 *  surfaces write and the `gate` one that must never appear here. */
async function storedParams(page: Page, nodeId: string): Promise<Record<string, number>> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    return { ...(w.__patch.nodes[id]?.params ?? {}) };
  }, nodeId);
}

/**
 * Wait, IN THE PAGE and counted in FRAMES, until `pos` passes `min`, and return
 * THE SAMPLE that satisfied it. The commit is rAF-coalesced, so a wait that
 * validated one frame and then re-read would be asserting on a different
 * sample than the one it checked (the "sample twice, assert on the second"
 * class); the frame cap only bounds a failure.
 */
async function waitStoredPos(page: Page, nodeId: string, min: number) {
  return page.evaluate(
    async ({ id, min }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const read = () => w.__patch.nodes[id]?.params.pos ?? -1;
      let frames = 0;
      let pos = read();
      while (pos < min && frames < 300) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        frames++;
        pos = read();
      }
      return { ok: pos >= min, frames, pos };
    },
    { id: nodeId, min },
  );
}

/** Press the strip at `frac` across it and HOLD (no pointer-up). */
async function pressStripAt(page: Page, strip: ReturnType<Page['locator']>, frac: number) {
  const box = await strip.boundingBox();
  expect(box, 'the strip has a layout box to press').not.toBeNull();
  if (!box) throw new Error('unreachable');
  await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}

test.describe('MOOG 956 RIBBON — the FACE (default shell)', () => {
  test('the lane tile paints the ranked cells AND its own strip; the dock paints both, once each', async ({
    page,
    rack,
    errorWatch,
  }) => {
    // `errorWatch` is this spec's pageerror guard: a derivation repaired on
    // ModuleShellPlaceholder can still throw in ModuleShell, and only promoting
    // reveals it — the guard fails the leg on any page error.
    void rack;
    await spawnPatch(page, [
      { id: 'mg', type: 'moog956', position: { x: 220, y: 120 }, domain: 'audio' },
    ]);

    const tile = page.locator('.svelte-flow__node[data-id="mg"]');
    await expect(
      tile.locator('[data-testid="module-shell"]'),
      'the promoted face renders a ModuleShell tile, not the placeholder',
    ).toBeVisible();
    await expect(tile.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);

    // Rank 1 paints at every tier, so it is the tier-independent claim (the
    // ptzcam lesson — never assert a specific tier's cell COUNT from the
    // default viewport).
    await expect(tile.locator('[data-testid="control-pos"]')).toBeVisible();

    // ⚠ THE HALF THIS PROMOTION EXISTS FOR. `faceTierCap('compact','none')` is
    // 3 and `gate` ranks fourth, so without the `tileBody` the lane could set a
    // pitch and never sound it. The tile strip is the whole gesture, on the
    // surface the module is normally met on.
    await expect(
      tile.locator('[data-testid="moog956-tile-ribbon"]'),
      'the lane tile carries the playable strip',
    ).toBeVisible();
    // …and the DOCK strip is not on the tile: the two slots are counterparts,
    // never siblings (ModuleShell gates `tileBody` on `!extBody`).
    await expect(tile.locator('[data-testid="moog956-face-ribbon"]')).toHaveCount(0);

    // ── the dock ──
    await tile.locator('[data-testid="module-shell"]').getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible();

    const body = dock.locator('[data-testid="moog956-face-body"]');
    await expect(body, 'the fullViewBody paints at the dock').toBeVisible();
    await expect(body.locator('[data-testid="moog956-face-ribbon"]')).toBeVisible();
    // The stated redundancy, pinned as INTENDED: the strip above and the four
    // parity-credited cells beneath — each anchor EXACTLY once, because the
    // strip emits none. A second `control-pos` here is the multiset failure
    // faces-parity would only catch a lane later.
    for (const key of ['pos', 'scale', 'offset', 'gate']) {
      await expect(
        dock.locator(`[data-testid="control-${key}"]`),
        `the dock band paints exactly one cell for '${key}'`,
      ).toHaveCount(1);
    }
    // The deleted readout stays deleted, and the value stays speakable
    // (owner-decisions 2026-08-31 item 11).
    await expect(dock.locator('[data-testid="moog956-readout"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="moog956-face-ribbon"]'))
      .toHaveAttribute('aria-valuetext', '0.0 st');

    errorWatch.assertClean();
  });

  test('the REAL SOURCE CHAIN: a finger on the tile strip gates a VCA and pitches a VCO', async ({
    page,
    rack,
    errorWatch,
  }) => {
    void rack;
    await spawnPatch(
      page,
      [
        { id: 'mg', type: 'moog956', position: { x: 60, y: 60 }, domain: 'audio' },
        { id: 'vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
        // base 0 = CLOSED; cvAmount 1 = the CV IS the gain. Stated rather than
        // relied on, so a future change to the VCA's defaults reddens here
        // instead of quietly making the negative control vacuous.
        {
          id: 'vca',
          type: 'vca',
          position: { x: 640, y: 60 },
          domain: 'audio',
          params: { base: 0, cvAmount: 1 },
        },
        { id: 'scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      ],
      [
        {
          id: 'e-pitch',
          from: { nodeId: 'mg', portId: 'pitch' },
          to: { nodeId: 'vco', portId: 'pitch' },
          sourceType: 'pitch',
          targetType: 'pitch',
        },
        {
          id: 'e-gate',
          from: { nodeId: 'mg', portId: 'gate' },
          to: { nodeId: 'vca', portId: 'cv' },
          sourceType: 'gate',
          targetType: 'cv',
        },
        {
          id: 'e-osc',
          from: { nodeId: 'vco', portId: 'sine' },
          to: { nodeId: 'vca', portId: 'audio' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-scope',
          from: { nodeId: 'vca', portId: 'audio' },
          to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    const strip = page
      .locator('.svelte-flow__node[data-id="mg"] [data-testid="moog956-tile-ribbon"]');
    await expect(strip, 'the lane strip is the surface being played').toBeVisible();

    // (1) NEGATIVE CONTROL, first and over a FULL window: nothing has touched
    //     the strip, the gate rests at 0, the VCA is closed. If this half is
    //     not silent, the positive halves prove nothing about the module.
    const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
    expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
    expect(
      before.rms,
      `a closed VCA must be silent before any touch — ${describeScopeWindow(before)}`,
    ).toBeLessThan(AUDIBLE_FLOOR);

    // (2) A finger lands at the far LEFT of the strip and STAYS DOWN. pos ~= 0,
    //     so pitch ~= 0 V and the VCO sounds C4 — through the gate the same
    //     stroke raised.
    const box = await pressStripAt(page, strip, 0.02);
    const low = await pollScopeBandAmp(page, 'scp', C4_HZ, BAND_FLOOR, AUDIBLE_CAP_MS);
    expect(low.samples, 'the SCOPE was sampled while the finger was down').toBeGreaterThan(0);
    expect(
      low.reachedThreshold,
      `a finger on the ribbon must gate the VCA open at C4 — best=${low.best.toFixed(4)} `
        + `samples=${low.samples} elapsed=${Math.round(low.elapsedMs)}ms`,
    ).toBe(true);

    // (3) STILL HOLDING, slide to the midpoint. `pos` 0.5 over the default
    //     2-octave span is 1 V, so the SAME running note moves up an octave —
    //     the glide the ribbon exists for, and proof the PITCH jack is live
    //     rather than merely the gate.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
    const held = await waitStoredPos(page, 'mg', 0.4);
    expect(
      held.ok,
      `the slide must reach the strip's midpoint (waited ${held.frames} frames; pos=${held.pos})`,
    ).toBe(true);
    const high = await pollScopeBandAmp(page, 'scp', C5_HZ, BAND_FLOOR, AUDIBLE_CAP_MS);
    expect(
      high.reachedThreshold,
      `sliding to the midpoint must move the note an octave up — best=${high.best.toFixed(4)} `
        + `samples=${high.samples} elapsed=${Math.round(high.elapsedMs)}ms`,
    ).toBe(true);
    // …and the octave it LEFT must go quiet, so the two probes are measuring a
    // MOVE rather than an addition.
    //
    // ⚠ THE RING IS WHY THIS NEEDS A SETTLING WINDOW, and it is measured, not
    // assumed: run immediately after the C5 probe exits, the C4 reading was
    // `best=0.0545 samples=1` — the scope's analyser ring is 2048 samples
    // (~43 ms at 48 k) deep, so the first buffer after the slide still CONTAINS
    // the octave below it, and `pollScopeBandAmp` max-holds. `sampleScopeRms`
    // spends a window letting the ring roll entirely past the slide, and the
    // same window does double duty as the control this assertion needs: `lo`
    // above the floor says the note is STILL SOUNDING, so a quiet C4 below
    // means it MOVED rather than that the VCA closed.
    const sustained = await sampleScopeRms(page, 'scp', 20, 20);
    expect(sustained.samples, 'the SCOPE was sampled while the note sustained').toBeGreaterThan(0);
    expect(
      sustained.lo,
      `the note must still be sounding after the slide (lo=${sustained.lo.toFixed(4)} `
        + `hi=${sustained.hi.toFixed(4)} samples=${sustained.samples})`,
    ).toBeGreaterThan(AUDIBLE_FLOOR);
    const stale = await pollScopeBandAmp(page, 'scp', C4_HZ, BAND_FLOOR, 300);
    expect(stale.samples, 'the C4 band was actually probed').toBeGreaterThan(0);
    expect(
      stale.reachedThreshold,
      `and C4 must have gone quiet — best=${stale.best.toFixed(4)} samples=${stale.samples}`,
    ).toBe(false);

    // (4) RELEASE. The gate falls (silence) and the PITCH IS HELD — the one
    //     behaviour this module's docs promise by name.
    await page.mouse.up();
    const lifted = await sampleScopeRms(page, 'scp', 25, 20);
    expect(lifted.samples, 'the SCOPE was sampled while closing').toBeGreaterThan(0);
    expect(
      lifted.lo,
      `lifting off must close the VCA (lo=${lifted.lo.toFixed(4)} hi=${lifted.hi.toFixed(4)} `
        + `samples=${lifted.samples})`,
    ).toBeLessThan(AUDIBLE_FLOOR);

    const after = await storedParams(page, 'mg');
    expect(after.pos, 'the wiper keeps its voltage — no snap-back').toBeGreaterThan(0.4);
    expect(
      'gate' in after,
      'a finger is not something a rack can be saved holding — `gate` must never be persisted',
    ).toBe(false);

    errorWatch.assertClean();
  });
});
