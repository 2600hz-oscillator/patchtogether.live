// e2e/tests/foxy-freeze-locks-wavetable.spec.ts
//
// E2E regression for FOXY's FREEZE TABLE button. Pins the snapshot-vs-live
// root cause discovered after PR #411 + #420 chased the wrong layer:
//
//   The card writes the freeze toggle by calling `set('freezeTable')(1)`,
//   which mutates `patch.nodes[id].params.freezeTable`. The reconciler then
//   diffs node.params and calls engine.setParam → the FOXY factory's
//   setParam(paramId, value) switch. Before this PR the switch had NO case
//   for the freeze* params, so the factory CLOSURE never learned about the
//   click. Worse, bridgeTick read freezeT via `num('freezeTable', 0)`, but
//   `num` reads from `p0 = node.params ?? {}` — a snapshot taken at factory
//   mount. So `freezeT` was permanently 0 no matter how many times the
//   button toggled. The button SAID "TABLE FROZEN" but the bridge kept
//   posting fresh wavetables every 42 ms.
//
// This spec proves the loop is closed end-to-end:
//   1. Spawn FOXY → SCOPE (for sample-level audio inspection).
//   2. Switch gen_mode to 1 (3D Shape Gen) via setParam (a deliberate
//      non-default mode so the regression has more SURFACE — the path
//      through generateShapes / scanShapesToVoxels / voxelsToWavetable
//      must respect freezeTable too).
//   3. Wait for the wavetable to engage.
//   4. Click FREEZE TABLE.
//   5. Capture: LIVE WAVETABLE canvas pixels + wavetable contents hash.
//   6. Wait 2s while frozen.
//   7. Re-capture. Both must MATCH (pixel-equal canvas, identical hash).
//   8. Click FREEZE TABLE again (unfreeze).
//   9. Wait 2s while live so the table evolves.
//   10. Re-capture. Both must DIFFER substantially from the frozen
//       captures (animating again).
//
// Comparison is INTRA-RUN (A vs B within a single test run), NOT against
// an absolute baseline PNG. The raster cursors + wavetable content are
// timing-dependent and shift between fresh test runs, so a baseline PNG
// from one run is fragile against the next. Intra-run comparison is the
// right primitive: the test asserts STABILITY-WHILE-FROZEN +
// EVOLUTION-AFTER-UNFREEZE, which are the actual regression signals.
// VRT-style absolute baselines for FOXY (with __foxyVrtSeed seeding the
// rasters) are already covered by vrt-scenes.ts; the bridge-not-wired bug
// hid there because the seed paint runs ONCE on mount, before any click.
//
// Two observables for redundancy:
//   * Wavetable contents hash (sum-of-squares across all 64×256 samples,
//     quantized to 6 decimals). Byte-identical reads of a frozen table
//     return the SAME hash; substantial table change shifts it by orders
//     of magnitude. This is the strongest signal — the actual bytes the
//     worklet is reading.
//   * LIVE WAVETABLE canvas pixels (≤ 5 px diff for "equal"). Belt-and-
//     suspenders for the user-visible render path.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the FOXY factory's current wavetable contents via the engine's
 *  `read('wavetableFrames')` seam. Returns a sum-of-squares hash across
 *  all samples, quantized to 6 decimals — stable for byte-identical reads
 *  of a frozen table and changes substantially when the table moves. */
async function readWavetableHash(page: Page, foxyId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (
          node: { id: string; type: string; domain: string },
          key: string,
        ) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const wt = eng.read(node, 'wavetableFrames') as
      | Array<Float32Array | ArrayLike<number>>
      | undefined;
    if (!wt || wt.length === 0) return null;
    let sum = 0;
    for (const frame of wt) {
      const n = frame.length;
      for (let i = 0; i < n; i++) {
        const v = frame[i] ?? 0;
        sum += v * v;
      }
    }
    // Quantize to 6 decimals so two reads of a frozen table return
    // exactly the same JS number (Float32 → Float64 widening is exact;
    // sum-of-squares of the same input is deterministic).
    return Math.round(sum * 1e6) / 1e6;
  }, foxyId);
}

/** Push a FOXY setParam through the engine — used for gen_mode. */
async function foxySetParam(
  page: Page,
  foxyId: string,
  paramId: string,
  value: number,
): Promise<void> {
  await page.evaluate(
    ({ id, k, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          setParam: (
            node: { id: string; type: string; domain: string },
            paramId: string,
            value: number,
          ) => void;
        } | null;
        __patch: {
          nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }>;
        };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return;
      // Mirror the card's `set(k)(v)` path: update params then route through
      // setParam (the reconciler would do this on its own from a transact;
      // we drive it inline so tests don't rely on the rAF tick).
      node.params[k] = v;
      eng.setParam(node, k, v);
    },
    { id: foxyId, k: paramId, v: value },
  );
}

/** Count differing bytes between two RGBA pixel arrays. Each pixel is 4 bytes
 *  (R+G+B+A) so byte-equal implies pixel-equal. */
function differingBytes(a: number[], b: number[]): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) n++;
  }
  return n;
}

/** Read the LIVE WAVETABLE canvas's exact RGBA backing-store pixels (NOT a
 *  composited screenshot). getImageData reads the canvas drawing buffer
 *  directly, so it's deterministic + independent of viewport zoom / the
 *  continuously-repainting sibling preview canvases — a composited
 *  `element.screenshot()` of a canvas inside an animating layer is NOT
 *  byte-stable even when the canvas itself is frozen (the canvas's own
 *  toDataURL proves the pixels are identical). This is a STRONGER observable
 *  for "the frozen wavetable held its pixels" than a screenshot. */
async function readWavetablePixels(page: Page, testId: string): Promise<number[]> {
  return page.getByTestId(testId).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return [];
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  });
}

test.describe('FOXY FREEZE TABLE locks the wavetable end-to-end (regression for #411 + #420)', () => {
  // FOXY mounts 3 SwoleBlocks + 3 RasterPainters + WAVECEL worklet, then
  // we run 2× 2s waits + 3 canvas screenshots + 3 audio probes. Locally
  // this finishes in ~9s, but on cold CI Linux runners the heavy mount
  // routinely overruns the 30s default. 90s gives ample headroom.
  test.setTimeout(90_000);
  test('frozen wavetable: 2s-apart snapshots equal; unfreeze: snapshot differs', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // FOXY (self-driving audio source) → SCOPE (ch1 audio in). SCOPE is the
    // canonical audio probe — its analyser samples the bridged audio path
    // directly. We're not asserting against ch1 samples in this spec (the
    // wavetable-contents hash + the canvas screenshot are tighter
    // observables), but wiring SCOPE forces a real audio-bridge edge so the
    // worklet actually plays the wavetable.
    await spawnPatch(
      page,
      [
        { id: 'foxy', type: 'foxy', position: { x: 80, y: 80 }, domain: 'audio' },
        { id: 'sc',   type: 'scope', position: { x: 600, y: 80 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_foxy_sc',
          from: { nodeId: 'foxy', portId: 'out_l' },
          to:   { nodeId: 'sc',   portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    // Switch FOXY to 3D Shape Gen mode (gen_mode = 1). The bug existed in
    // BOTH modes, but the shapes path is the one previous PRs touched, so
    // it's the more interesting surface to lock down.
    await foxySetParam(page, 'foxy', 'gen_mode', 1);

    // Wait for the bridge to fill rasters + post a wavetable + the SCOPE
    // analyser to lock onto the audio. 1.5s is well beyond BRIDGE_MS=42 *
    // 32 = 1.3s, so all three rasters have fully filled.
    await page.waitForTimeout(1500);

    // ── Phase 1: FREEZE TABLE ──
    // Click the button. The card calls `set('freezeTable')(1)`, which goes
    // through patch.nodes mutation → reconciler diff → engine.setParam →
    // foxy.ts setParam switch (the new freezeTable case sets the closure
    // mirror). The bridge tick reads the closure mirror and skips the
    // wtFrames reassign + the loadWavetable post.
    await page.getByTestId('foxy-freeze-table').click();
    // Belt-and-suspenders: wait a settle so the reconciler has routed
    // through setParam + the next bridgeTick has observed the new state
    // (BRIDGE_MS=42 throttle ⇒ up to 42 ms can elapse). 300 ms covers it.
    await page.waitForTimeout(300);

    // Capture A: frozen — first snapshot. Read the canvas's exact RGBA pixels
    // (getImageData), not a composited screenshot — see readWavetablePixels.
    const wavetableA = await readWavetableHash(page, 'foxy');
    expect(wavetableA, 'wavetable hash readable after freeze').not.toBeNull();
    const pngA = await readWavetablePixels(page, 'foxy-wavetable');

    // ── Phase 2: wait 2 s while frozen ──
    // During this window the rasters + XYZ scope keep evolving (FrT freezes
    // ONLY the wavetable), but wtFrames + the LIVE WAVETABLE canvas pixels
    // must stay identical. This is the EXACT failure mode of the bug — the
    // factory was happily re-posting wavetables every 42 ms while the
    // button cosmetically said "TABLE FROZEN".
    await page.waitForTimeout(2000);

    // Capture B: still frozen, 2 s later.
    const wavetableB = await readWavetableHash(page, 'foxy');
    expect(wavetableB, 'wavetable hash readable 2s into freeze').not.toBeNull();
    const pngB = await readWavetablePixels(page, 'foxy-wavetable');

    // ── Assertion 1: A === B (frozen wavetable held its content). ──
    // Hash equality is the strongest signal — the contents the worklet is
    // playing back are byte-identical.
    expect(
      wavetableB,
      `wavetable hash drifted while FREEZE TABLE was on: A=${wavetableA}, B=${wavetableB}. ` +
        `That means the factory closure didn't observe the click — the snapshot-vs-live ` +
        `bug PR #411 + #420 never closed. setParam(freezeTable, 1) must be wired ` +
        `into the factory's setParam switch.`,
    ).toBe(wavetableA);

    // Canvas pixel equality (belt-and-suspenders). The two RGBA buffers are the
    // canvas's exact backing-store pixels 2 s apart while frozen — they must be
    // byte-identical (the canvas draws from wtFrames; if wtFrames is frozen,
    // draws are identical pixel-by-pixel). getImageData is deterministic, so we
    // require an EXACT match (0 byte diffs).
    const diffAB = differingBytes(pngA, pngB);
    expect(
      diffAB,
      `LIVE WAVETABLE canvas pixels drifted while frozen (${diffAB} bytes diff). ` +
        `Canvas A size=${pngA.length}, B size=${pngB.length}.`,
    ).toBe(0);

    // ── Phase 3: UNFREEZE + 2 s of live ──
    await page.getByTestId('foxy-freeze-table').click();
    await page.waitForTimeout(2000);

    // Capture C: live, after 2 s of motion.
    const wavetableC = await readWavetableHash(page, 'foxy');
    expect(wavetableC, 'wavetable hash readable after unfreeze').not.toBeNull();
    const pngC = await readWavetablePixels(page, 'foxy-wavetable');

    // ── Assertion 2: C differs substantially from A (table evolves). ──
    // The raster cursors have drifted ~48 bridge ticks during the 2 s of
    // live + the 3D Shape Gen path keeps generating new shapes each tick,
    // so the wavetable contents are guaranteed to have moved. We compare
    // against a generous 0.1 floor so the assertion can't false-positive
    // on a perfectly-static table (which would also be a regression but
    // a different one).
    expect(
      Math.abs(wavetableC! - wavetableA!),
      `wavetable hash failed to evolve after unfreeze: A=${wavetableA}, C=${wavetableC}. ` +
        `That means the unfreeze path didn't re-engage the loadWavetable posts.`,
    ).toBeGreaterThan(0.1);

    // Canvas C must differ substantially from A — the live table evolution
    // paints a visibly different waveform on the canvas. We assert ≥ 100 RGBA
    // byte diffs so the unfreeze genuinely re-engaged the live draw.
    const diffAC = differingBytes(pngA, pngC);
    expect(
      diffAC,
      `LIVE WAVETABLE canvas failed to evolve after unfreeze (${diffAC} bytes diff vs ` +
        `frozen == 0).`,
    ).toBeGreaterThan(100);

    // Ignore the AudioContext autoplay warning that always fires before the
    // first user gesture lands.
    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      `console / page errors during freeze cycle: ${errors.join('; ')}`,
    ).toEqual([]);
  });
});
