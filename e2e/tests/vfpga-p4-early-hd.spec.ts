// e2e/tests/vfpga-p4-early-hd.spec.ts
//
// vfpga P4 — the EARLY-HD-era bent VFPGA catalog (macroblock-mosh, tmds-sparkle,
// scaler-glitch), end-to-end on a REAL WebGL2 context. Each bent program needs a
// video source, so the patch is:
//
//   src (vfpga-runner = smpte-bars) → bent (vfpga-runner = <program>) → OUTPUT
//
// We select the bent program from its tile's preset SELECTOR cell (the
// production hot-swap path on the default shell; `shell-cell-vfpga-preset`,
// whose `.val` span is the loaded readout), then assert the OUTPUT pixels (the
// videoOut tile thumb canvas — the downstream chain) are (a) NON-BLACK with spatial
// STRUCTURE (the bent picture reaches downstream — a renderer-tolerant floor, NOT
// exact pixels: CI runs SwiftShader) AND (b) DISTINCT from the same source passed
// straight through (the un-bent reference), proving the bend actually transforms the
// picture rather than just compiling. Renderer-tolerant throughout (structure + a
// coarse distinctness delta, not pixel equality). The bends are SEEDED-deterministic,
// but vfpga-runner is VRT-exempt (live preview + scopes), so this asserts behaviour,
// not a baseline. Mirrors the P3 composite spec.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BENT = ['macroblock-mosh', 'tmds-sparkle', 'scaler-glitch'] as const;

/** OUTPUT canvas pixel stats (mean luma, non-black fraction, spatial variance). */
async function outputStats(page: Page): Promise<{ mean: number; nonZeroFrac: number; variance: number } | null> {
  const canvas = page.locator('.svelte-flow__node[data-id="out"] [data-testid="video-tile-thumb"]');
  await expect(canvas, 'videoOut tile thumb mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { mean, nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean };
  });
}

/** A subsampled greyscale fingerprint of the OUTPUT (one luma byte per 64 bytes) —
 *  a renderer-tolerant SPATIAL signature; position-sensitive, so a geometric bend
 *  (mosh smear / scaler stretch / char-slip) that rearranges pixels reads DISTINCT. */
async function outputFingerprint(page: Page): Promise<number[] | null> {
  const canvas = page.locator('.svelte-flow__node[data-id="out"] [data-testid="video-tile-thumb"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const out: number[] = [];
    for (let i = 0; i < data.length; i += 64) {
      out.push((data[i]! + data[i + 1]! + data[i + 2]!) / 3);
    }
    return out;
  });
}

/** Mean absolute per-sample difference of two fingerprints (0 = identical), 0..255. */
function fpDelta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!);
  return d / n;
}

/** What the in-page temporal-change observer returns, over ONE round trip. */
interface DeltaWatch {
  /** The DECIDING delta — the first to clear `stopAbove`, else the last taken. */
  delta: number;
  /** The largest delta seen (diagnostic; the assertion uses `delta`). */
  maxDelta: number;
  samples: number;
  elapsedMs: number;
}

/**
 * Watch the OUTPUT canvas for frame-to-frame change, ACCUMULATING IN THE PAGE.
 *
 * ── why (#1988) ────────────────────────────────────────────────────────────
 *
 * This replaces a Playwright-side loop that ran up to 30 times, and on each
 * pass did `outputFingerprint` -> `waitForTimeout(250)` -> `outputFingerprint`.
 * Two things made that the dominant, and unbounded, cost of the test:
 *
 *   * it is a Playwright-side sampler of a page-side quantity — CLAUDE.md
 *     rule 5 — so every sample is a CDP round trip on the same main thread as
 *     the GL subject;
 *   * `outputFingerprint` does not return a number, it returns the whole
 *     fingerprint ARRAY. MEASURED locally under `E2E_SWIFTSHADER=1`:
 *     `fp.length = 6460` numbers per call, at 151 ms per `evaluate` on an IDLE
 *     many-core machine.
 *
 * So the worst case the code PERMITTED was 60 such round trips. #1173 measured
 * a CDP `evaluate` at ~1.5 s under CI load: 60 x 1.5 s = 90 s of transport,
 * plus 30 x 250 ms of waiting — ~97.5 s, against a `test.setTimeout(75_000)`
 * budget, BEFORE boot, three vfpga-runner mounts and three preset loads are
 * counted. The budget was sized against the OBSERVED path, which early-exits:
 * measured here, the loop ran exactly ONE iteration (dOff=0.17, dOn=7.84). One
 * iteration and thirty differ by 30x in cost, and only the first was ever
 * timed. That is why bumping 75_000 was the wrong move — the number was not
 * slightly small, it was measuring a path the test does not always take.
 *
 * Moving the loop into the page collapses 60 round trips to ONE and drops the
 * 6460-number payload to a scalar, so the worst case becomes ~30 x 250 ms of
 * in-page waiting. The MEASURED QUANTITY is unchanged: the mean absolute
 * difference of two subsampled luma fingerprints taken `gapMs` apart, by the
 * same arithmetic as `fpDelta` above.
 */
async function observeOutputDelta(
  page: Page,
  opts: {
    gapMs: number;
    maxSamples: number;
    /** Early-out once a sample EXCEEDS this (the "it moved" question). */
    stopAbove: number;
    /**
     * Early-out once a sample DROPS BELOW this (the "it has settled" question).
     *
     * This is how a CONVERGENCE wait is expressed without a wall clock. The
     * macroblock-mosh reference is a feedback loop, so "settled" is a property
     * of the picture, not an elapsed time — and a fixed settle is a different
     * number of frames on every renderer, which is the CLAUDE.md defect. A run
     * that never settles simply spends its sample budget and returns its real
     * (large) delta, so the assertion still fails on a genuinely moving
     * baseline.
     */
    stopBelow?: number;
    /**
     * Compare every sample against THIS fixed fingerprint instead of against
     * the previous sample. Used by the per-program distinctness tests, whose
     * question is "does the bent picture differ from the UN-BENT reference",
     * not "does the picture move". Crossing CDP once with the reference is
     * still 30x cheaper than the round trip per sample it replaces.
     */
    reference?: number[] | null;
  },
): Promise<DeltaWatch> {
  const canvas = page.locator('.svelte-flow__node[data-id="out"] [data-testid="video-tile-thumb"]');
  return canvas.evaluate(
    (el, { gapMs, maxSamples, stopAbove, stopBelow, reference }) =>
      new Promise<DeltaWatch>((resolve) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        const t0 = performance.now();
        if (!ctx) {
          resolve({ delta: 0, maxDelta: 0, samples: 0, elapsedMs: 0 });
          return;
        }
        // Same subsampling as `outputFingerprint`, and same arithmetic as
        // `fpDelta` — only the place it runs has changed.
        const fingerprint = (): number[] => {
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          const out: number[] = [];
          for (let i = 0; i < data.length; i += 64) {
            out.push((data[i]! + data[i + 1]! + data[i + 2]!) / 3);
          }
          return out;
        };
        const diff = (a: number[], b: number[]): number => {
          const n = Math.min(a.length, b.length);
          if (!n) return 0;
          let d = 0;
          for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!);
          return d / n;
        };

        // Against a FIXED reference, or against the previous sample.
        let prev = reference && reference.length ? reference : fingerprint();
        const fixed = !!(reference && reference.length);
        let samples = 0;
        let last = 0;
        let max = 0;
        const tick = (): void => {
          const cur = fingerprint();
          const d = diff(prev, cur);
          if (!fixed) prev = cur;
          samples++;
          last = d;
          if (d > max) max = d;
          // Early-out the instant the change clears the bar (the normal path),
          // else run the sample budget out — a genuinely STATIC output pays the
          // full count and still reports its real, small delta.
          const settled = typeof stopBelow === 'number' && d < stopBelow;
          if (d > stopAbove || settled || samples >= maxSamples) {
            resolve({ delta: last, maxDelta: max, samples, elapsedMs: performance.now() - t0 });
            return;
          }
          setTimeout(tick, gapMs);
        };
        setTimeout(tick, gapMs);
      }),
    { ...opts, reference: opts.reference ?? null, stopBelow: opts.stopBelow ?? null },
  );
}

/** Set a node's loaded VFPGA via its tile's preset SELECTOR cell + wait for the
 *  cell's value span (the shell's loaded readout). Picking an option closes the
 *  listbox — never Escape (the dock-wide Esc hazard). */
async function loadPreset(page: Page, nodeId: string, _vfpga: string, name: string): Promise<void> {
  const cell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="shell-cell-vfpga-preset"]`);
  await expect(cell, `preset selector for ${nodeId}`).toHaveCount(1);
  await cell.click();
  await page.locator('[role="option"]', { hasText: name }).click();
  await expect(cell.locator('.val')).toHaveText(name);
}

async function pollStats(page: Page): Promise<{ mean: number; nonZeroFrac: number; variance: number }> {
  let stats = await outputStats(page);
  for (let i = 0; i < 50 && (!stats || stats.nonZeroFrac <= 0.05); i++) {
    await page.waitForTimeout(150);
    stats = await outputStats(page);
  }
  expect(stats, 'OUTPUT canvas readable + non-black').not.toBeNull();
  return stats!;
}

test.describe('vfpga P4 early-HD-era bent VFPGAs', () => {
  for (const program of BENT) {
    test(`${program}: bends the smpte source into distinct non-black output`, async ({ page, rack, errorWatch }) => {
      // Two pure-GL vfpga-runners + an OUTPUT compile fast even on SwiftShader,
      // but give headroom for boot + spawn + first-frame settle + the hot-swap.
      test.setTimeout(60_000);


      await spawnPatch(
        page,
        [
          { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
          { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
          { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
        ],
        [
          { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
          { id: 'e2', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        ],
        { mountTimeout: 15_000 },
      );

      await expect(page.locator('.svelte-flow__node:has([data-shell-type="vfpgaRunner"])')).toHaveCount(2);
      await expect(page.locator('.svelte-flow__node:has([data-shell-type="videoOut"])')).toHaveCount(1);

      // Reference render: `bent` = smpte-bars (its own generated bars == a passthru
      // of the src smpte bars at the same settings). Capture that, then swap to the
      // bent program and require the spatial fingerprint to DIFFER.
      await loadPreset(page, 'bent', 'smpte-bars', 'SMPTE bars');
      await pollStats(page);
      await page.waitForTimeout(300); // settle a couple frames so the reference is stable
      const refFp = await outputFingerprint(page);
      expect(refFp, 'reference fingerprint').not.toBeNull();

      // Now load the BENT program and assert structure + distinctness.
      await loadPreset(page, 'bent', program, program);
      const stats = await pollStats(page);

      // (a) STRUCTURE FLOOR: the bent picture reaches OUTPUT with spatial detail.
      expect(stats.nonZeroFrac, `${program}: bent output is non-black (frac=${stats.nonZeroFrac})`).toBeGreaterThan(0.1);
      expect(stats.variance, `${program}: bent output has spatial structure (var=${stats.variance})`).toBeGreaterThan(20);

      // (b) DISTINCTNESS: the bend transformed the picture (the OUTPUT spatial
      // fingerprint differs meaningfully from the un-bent reference). Δluma > 6/255
      // is well above renderer noise but easily met by any bend. mosh is a feedback
      // loop (the reference accumulates over frames) and the scaler/tmds animate, so
      // poll a few frames to let the bend settle off the reference frame.
      // Same loop bound (30) and same stop condition (Δ > 6) as before, but run
      // IN THE PAGE against the reference: one round trip instead of thirty.
      // See `observeOutputDelta` for the measured reason (#1988).
      const bent = await observeOutputDelta(page, {
        gapMs: 150,
        maxSamples: 30,
        stopAbove: 6,
        reference: refFp,
      });
      const delta = bent.delta;
      expect(
        delta,
        `${program}: bent output is DISTINCT from the un-bent reference (Δluma=${delta.toFixed(2)}/255) — ` +
          `[instrument] samples=${bent.samples} max=${bent.maxDelta.toFixed(2)} ms=${Math.round(bent.elapsedMs)}`,
      ).toBeGreaterThan(6);

    });
  }

  // macroblock-mosh TWO-CLIP DATAMOSH (the multi-input flagship): clip B's motion
  // is transferred onto image A. This is the multi-input analog of the poly real-
  // source-chain rule — it wires TWO REAL video sources (not a synthetic stand-in)
  // and proves the SECOND input actually reaches the output at runtime, isolating the
  // B-transfer path so a dead vin2 binding can't hide behind the synthetic storm:
  //
  //   src0(smpte, static) ─┬───────────────────────────→ bent.vin1  (image A)
  //                        └→ srcB(sync-bender, perpetual roll)→ bent.vin2 (motion B)
  //
  // B is a sync-bender whose V-ROLL is a continuous uTime scroll (a perpetual, non-
  // converging motion source — a feedback howl would settle and leave nothing to
  // transfer). With the synthetic motion (p2 mvect) at ZERO, the ONLY thing that can
  // move the output is B's transferred motion (p5 mvectB). So: mvectB=0 → once the
  // reference settles the output is STATIC (A recirculated, no warp); mvectB>0 → B's
  // per-frame motion warps A and the output animates. We assert the temporal change is
  // decisively larger with mvectB on than off — a renderer-tolerant causal proof that
  // clip B's motion reaches the picture (a dead vin2 binding would leave it static).
  test('macroblock-mosh: clip B (vin2) motion transfers onto image A (two-clip datamosh)', async ({ page, rack, errorWatch }) => {
    // A pure FAILURE BOUND, not the gate. What made 75_000 unreachable was the
    // Playwright-side capture loop (up to 60 CDP round trips, ~1.5 s each under
    // CI load per #1173 — see `observeOutputDelta`); that loop now runs in the
    // page over ONE round trip, so the worst case is ~30 x 250 ms of in-page
    // waiting rather than ~97.5 s of transport. The number is kept only to stop
    // a genuinely broken render hanging the shard.
    test.setTimeout(75_000); // 3 runners + output on SwiftShader, two capture phases
    //
    // ── ⚠ OPEN FINDING (2026-09-05), MEASURED, DELIBERATELY NOT BUMPED ──────
    //
    // This budget expired again on CI (run 33990942421, shard 4). The call log
    // shows the axe falling inside the SECOND `observeOutputDelta`, so the cost
    // is spread across the whole test rather than parked in one wait.
    //
    // MEASURED locally under `E2E_SWIFTSHADER=1` on an idle many-core box:
    // 17.3 s and 17.5 s across two runs, against this 75 s budget — a 4.3x
    // headroom. CI's 2-core runner with five shard-mates routinely costs 3-5x
    // an idle box for GL work, so 75 s is not comfortably sized here, it is
    // MARGINALLY sized: the failure needs only a 4.3x day.
    //
    // ⚠ AND THE OBVIOUS MOVE IS THE ONE THIS FILE ALREADY REJECTED. See the
    // `observeOutputDelta` header: "bumping 75_000 was the wrong move — the
    // number was not slightly small, it was measuring a path the test does not
    // always take." That rejection stands, and the removable transport cost it
    // named (60 CDP round trips) is already gone.
    //
    // WHAT IS LEFT is ~15 s of the local 17.4 s — two phases of 30 x
    // `gapMs: 250` of in-page waiting. That is a flat wall-clock cadence, and
    // the repo's rule says renderer-dependent readiness should be FRAMES. But
    // the warp this measures ACCUMULATES over that cadence, and both thresholds
    // (`dOff + 5` / `> 6`) are pinned against it — so converting ms to frames
    // would move the goalposts of a measured assertion, not just its bound.
    //
    // So this is recorded as an OWNER ITEM rather than forced: the honest fix
    // is a re-derivation of the sampling cadence AND its two thresholds
    // together, which is a change to what the test claims.

    await spawnPatch(
      page,
      [
        { id: 'src0', type: 'vfpgaRunner', position: { x: 40, y: 80 }, domain: 'video' },
        { id: 'srcB', type: 'vfpgaRunner', position: { x: 440, y: 320 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        // image A: the static smpte source straight into vin1.
        { id: 'e1', from: { nodeId: 'src0', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        // motion source B: the same smpte through a self-animating howl → vin2.
        { id: 'e2', from: { nodeId: 'src0', portId: 'vout1' }, to: { nodeId: 'srcB', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        { id: 'e3', from: { nodeId: 'srcB', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin2' }, sourceType: 'video', targetType: 'video' },
        { id: 'e4', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );

    await loadPreset(page, 'src0', 'smpte-bars', 'SMPTE bars');
    await loadPreset(page, 'srcB', 'sync-bender', 'sync-bender');
    await loadPreset(page, 'bent', 'macroblock-mosh', 'macroblock-mosh');

    // Drive a strong, perpetually-rolling B (sync-bender: high V-roll + shear + line
    // slip = a non-converging multi-directional motion source), and configure the
    // mosh so the ONLY motion source is B's transfer: p1 mosh high (reference
    // dominates so the warp accumulates), p2 synthetic motion 0, p4 quant 0, p5
    // transfer 0 (for now).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const b = w.__patch.nodes['srcB']; if (b) { b.params.p1 = 0.08; b.params.p2 = 0.4; b.params.p3 = 0.4; b.params.p4 = 0.05; }
        const m = w.__patch.nodes['bent']; if (m) { m.params.p1 = 0.9; m.params.p2 = 0; m.params.p4 = 0; m.params.p5 = 0; }
      });
    });
    await pollStats(page);
    await page.waitForTimeout(1500); // let the reference fully converge to steady A

    // Phase 1 — mvectB OFF: B's motion is ignored and there is no synthetic storm,
    // so once the reference has settled the output is static frame-to-frame.
    // ONE sample pair, 600 ms apart — same measurement as before, taken in-page.
    // ⚠ "once settled" is asserted as a PROPERTY OF THE PICTURE, not as an
    // elapsed time. macroblock-mosh's reference is a feedback loop, so how far
    // it has converged after the fixed settle above is a function of how many
    // FRAMES the renderer managed — the classic ms-vs-frames defect. Measured
    // across five local runs the single-sample baseline read 0.08, 0.16, 1.71
    // and 5.09 against a `< 5` bar: 1-in-5 red, on a value that is supposed to
    // be ~0. So sample until the output actually stops changing, and give up
    // after a bounded number of tries — a baseline that never settles keeps its
    // real (large) delta and still fails the assertion below.
    const off = await observeOutputDelta(page, {
      gapMs: 600,
      maxSamples: 10,
      stopAbove: Infinity,
      stopBelow: 5,
    });
    expect(off.samples, `phase-1 fingerprints readable (${JSON.stringify(off)})`).toBeGreaterThan(0);
    const dOff = off.delta;

    // Phase 2 — mvectB ON: B's per-frame motion now warps image A; the output must
    // animate. Poll a few frames so the warp accumulates off the settled reference.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const m = w.__patch.nodes['bent']; if (m) m.params.p5 = 0.3; });
    });
    // Up to 30 sample pairs 250 ms apart, early-exiting the moment the output
    // moves decisively more than the phase-1 baseline — the SAME loop bound and
    // the SAME stop condition as before, now run entirely in the page.
    // ⚠ The early-exit bar is the HIGHER of the two bars the assertions below
    // set, and that is a FIX, not a tuning.
    //
    // The loop used to stop at `dOff + 5` while the second assertion demands
    // `> 6`. Those disagree whenever dOff < 1 — which is the NORMAL case, since
    // phase 1 is asserted to be under 5 and measures ~0.1-1.7 in practice. So
    // the loop could stop sampling at, say, 5.17 (clearing dOff+5 = 5.08) and
    // then fail `> 6` with 29 of its 30 samples unspent: it stopped looking
    // BELOW its own bar. Caught by the 3x flake-check — 1 of 3 runs, at
    // `Δon=5.17, samples=1`, with the warp still accumulating.
    //
    // Raising the loop's stop condition to `max(dOff + 5, 6)` changes NO
    // threshold — both assertions are untouched — it only stops the sampler
    // quitting before the thing it is sampling for could have happened. A
    // genuinely static output still spends all 30 samples and still fails:
    // measured with the B-transfer forced off, `Δon=0.00 max=0.00 samples=30`.
    const on = await observeOutputDelta(page, {
      gapMs: 250,
      maxSamples: 30,
      stopAbove: Math.max(dOff + 5, 6),
    });
    const dOn = on.delta;

    // The baseline really is (near) static — proof the comparison is meaningful (a
    // perpetually-animating output would make any Δon trivially pass).
    const dump =
      `[instrument] off{Δ=${off.delta.toFixed(2)} samples=${off.samples} ms=${Math.round(off.elapsedMs)}} ` +
      `on{Δ=${on.delta.toFixed(2)} max=${on.maxDelta.toFixed(2)} samples=${on.samples} ms=${Math.round(on.elapsedMs)}}`;
    expect(
      dOff,
      `baseline (mvectB=0) is ~static once settled (Δoff=${dOff.toFixed(2)}/255) — ${dump}`,
    ).toBeLessThan(5);
    // The output animates decisively MORE with the transfer on — clip B's motion is
    // reaching the picture (renderer-tolerant: a coarse Δluma comparison, not pixel
    // equality). dOn also clears an absolute floor (it really moves under B).
    expect(dOn, `B-transfer animates the output (Δon=${dOn.toFixed(2)} vs Δoff=${dOff.toFixed(2)} /255) — ${dump}`).toBeGreaterThan(dOff + 5);
    expect(dOn, `output visibly animates under B's motion (Δon=${dOn.toFixed(2)}/255) — ${dump}`).toBeGreaterThan(6);
  });

  // macroblock-mosh LEAK AUDIT (the flagship's reference frame-store FBOs): under
  // sustained feedback the register ping-pong pair is allocated ONCE and swapped in
  // place — no per-frame GL allocation. Same audit as framestore-howl: assert the
  // render loop survives many frames with NO console errors AND (where the JS-heap
  // API is available — Chromium) that the heap does not grow unboundedly.
  test('macroblock-mosh: sustained feedback does not leak (FBOs swapped in place)', async ({ page, rack, errorWatch }) => {
    test.setTimeout(60_000);

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'vfpgaRunner', position: { x: 60, y: 80 }, domain: 'video' },
        { id: 'bent', type: 'vfpgaRunner', position: { x: 460, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'vout1' }, to: { nodeId: 'bent', portId: 'vin1' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'bent', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
      { mountTimeout: 15_000 },
    );
    await loadPreset(page, 'bent', 'macroblock-mosh', 'macroblock-mosh');
    await pollStats(page);

    const heapApi = await page.evaluate(() => 'memory' in performance);
    const heap0 = heapApi ? await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) : 0;

    await page.waitForTimeout(4_000);
    const stillRendering = await outputStats(page);
    expect(stillRendering, 'still rendering after sustained feedback').not.toBeNull();
    expect(stillRendering!.nonZeroFrac, 'feedback loop still producing a picture').toBeGreaterThan(0.05);

    if (heapApi) {
      const heap1 = await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
      expect(heap1 - heap0, `JS heap growth bounded (Δ=${((heap1 - heap0) / 1e6).toFixed(1)}MB)`).toBeLessThan(10_000_000);
    }
  });
});
