// e2e/tests/outlines-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for OUTLINES — a STATEFUL particle video
// SOURCE. Modeled on spirographs-render-smoke.spec.ts + the shared
// _render-smoke harness (installRenderSmokeHooks / stepAndReadStats /
// assertRenderStats).
//
// WHY THIS MODULE WAS DEFERRED, AND THE UNBLOCK:
//
// OUTLINES does NOT derive its scene from frame.time alone (unlike SPIROGRAPHS).
// It is a particle sim: shapes only exist once SPAWNED (by a gate rising edge or
// the internal rate clock), then integrate/bounce/decay over dt. Under the DRS
// freeze hooks `frame.time` is PINNED, so draw()'s `dtMs = (t - lastTime)*1000`
// is ~16.67 ms on the first step (lastTime=-1 seeds 1/60) and EXACTLY 0 on every
// step after (t == lastTime). With DEFAULT params (rate=0.5 → a ≥500 ms internal
// clock interval) only ~16.67 ms ever accumulates, so the rate clock NEVER fires
// and the field stays EMPTY → black. That is the Phase-1 deferral: a frozen step
// spawns nothing, so the source renders black.
//
// UNBLOCK (params + seed + one deterministic spawn burst — NOT a live gate over
// time): we make a FIXED set of shapes EXIST before the first frozen step, and
// pin them so the frozen scene is bit-stable:
//
//   * __outlinesVrtSeed (via addInitScript, before boot): the spawn RNG is
//     seeded with a fixed value, so each shape's seeded position + baseAngle is
//     reproducible — the painted frame is deterministic.
//   * Spawn params chosen so the shapes are LARGE, STATIC and PERSISTENT:
//       d=1     → 270 px (D_MAX) circumdiameter — big coverage so the overlap
//                 fill clears the non-black + variance floors comfortably.
//       spd=0   → latched velocity is (0,0): integration never moves the shape,
//                 so the frozen-time dtMs (16.67 ms then 0) changes NOTHING.
//       decay=0 → no fade-out: the shape persists (never removed) across both
//                 step bursts.
//       rate=0  → internal clock OFF: the ONLY shapes are the ones we spawn,
//                 so the count is exactly fixed (no timing-dependent extras).
//       rotation=0.5 (center, the default) → no live spin, so nothing animates
//                 even on step 1's non-zero dt.
//   * A FIXED number of GATE rising edges fired ONCE via setParam(cv_gate,1→0)
//     BEFORE any step. Each rising edge runs sim.spawnFromGate() SYNCHRONOUSLY
//     inside setParam (it latches the live d/spd/decay and draws seeded RNG), so
//     after this burst the sim holds exactly N seeded, static, persistent shapes.
//     This is a one-shot deterministic spawn (a fixed count of synchronous
//     edges), NOT "firing a live gate over time" — no waitForTimeout, no polling,
//     no per-frame gate cadence.
//
// With static + persistent + no-spin shapes and a pinned clock, the two
// independent step bursts paint an IDENTICAL frame (the circle list is unchanged
// between them) → frame-stable mean + variance. We read the `combine` output
// (the module's canonical default output; a colorized overlap-count video).
//
// No waitForTimeout / poll / animation-diff / exact-pixel assert.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;
/** Number of deterministic gate spawns fired ONCE before stepping. Big static
 *  270 px shapes — a dozen scattered across the 1024 field cover a large area +
 *  stack into ≥2-overlap regions, so combine renders dense colour. Far below the
 *  MAX_CIRCLES=200 cap, so none are culled (count stays exactly this). */
const SPAWN_COUNT = 12;
/** Fixed RNG seed → reproducible spawn positions + baseAngles. */
const OUTLINES_SEED = 0x0c1c1e5;

test.describe('OUTLINES — deterministic render smoke', () => {
  test('seed + fixed gate spawn + freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pin the spawn RNG seed BEFORE boot so the factory (which reads
    // globalThis.__outlinesVrtSeed at node mount) constructs a deterministic sim.
    await page.addInitScript((seed) => {
      (globalThis as unknown as { __outlinesVrtSeed?: number }).__outlinesVrtSeed = seed;
    }, OUTLINES_SEED);

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // OUTLINES is a stateful particle SOURCE → its own OUTPUT. We read its
    // `combine` output (canonical default; colorized overlap-count video). Spawn
    // params make every shape LARGE (d=1 → 270 px), STATIC (spd=0) and PERSISTENT
    // (decay=0), with the internal clock OFF (rate=0) so the ONLY shapes are the
    // fixed gate-spawn burst below.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'outlines', position: { x: 100, y: 100 }, domain: 'video', params: { rate: 0, spd: 0, decay: 0, d: 1 } },
        { id: 'out', type: 'videoOut', position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'combine' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="outlines-card"]'), 'OUTLINES card present').toHaveCount(1);

    // Fire a FIXED number of deterministic gate rising edges ONCE (synchronous —
    // each edge spawns one seeded shape inside setParam, before any step). This
    // is the unblock: it makes content EXIST without relying on a frozen frame to
    // spawn it, and without a live gate cadence over time.
    await page.evaluate(({ nodeId, n }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      for (let i = 0; i < n; i++) {
        ve?.setParam?.(nodeId, 'cv_gate', 1); // rising edge → spawnFromGate()
        ve?.setParam?.(nodeId, 'cv_gate', 0); // release → re-arm the edge detector
      }
    }, { nodeId: 'm', n: SPAWN_COUNT });

    // First burst: drive a FIXED number of frames synchronously + read `combine`.
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'combine', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen, shapes static
    // + persistent) must produce a frame-stable result — same mean + variance to
    // a tight epsilon, exact frame delta.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'combine', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
