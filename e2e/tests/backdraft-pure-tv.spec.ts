// e2e/tests/backdraft-pure-tv.spec.ts
//
// BACKDRAFT PURE TV / CRITICAL — proves the GPU really renders the bounded
// screen. The GEOMETRY itself is proven in the GL-free CPU mirror
// (backdraft-tv.test.ts, N1-N10 + N-INV); this spec only has to show that the
// shader agrees with it, plus that TV MODE = OFF leaves the legacy path alone.
//
// RENDERER TOLERANCE is deliberate throughout: every assertion is a ratio, a
// count, or a monotonicity over large-scale geometry — never a pixel value and
// never a filtering-sensitive quantity. The tap minifies by 1/s = 1.333 with
// LINEAR and no mipmaps, so SwiftShader (CI) and a real GPU diverge more with
// every one of the ~11 compounded resamples. No pixel-value assertion at depth.
//
// The room is PIXELATE = 1, which collapses the source to a single flat colour.
// That is a legitimate patch setting and it makes the room a uniform bright
// field, so the bezel bands are pure geometry rather than geometry plus source
// texture — the most renderer-stable form of the same claim.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page, Locator } from '@playwright/test';

/** Read the canvas centre row (one value per pixel, luma-ish on the red ch). */
async function centreRow(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return [];
    const y = Math.floor(c.height / 2);
    const d = ctx.getImageData(0, y, c.width, 1).data;
    const out: number[] = [];
    for (let x = 0; x < c.width; x++) out.push(d[x * 4]! / 255);
    return out;
  });
}

/** Mean of each screen quadrant, 0..1 — the renderer-tolerant OFF-path probe. */
async function quadrants(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return [];
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const q = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = ((y * c.width + x) * 4);
        const k = (y < c.height / 2 ? 0 : 2) + (x < c.width / 2 ? 0 : 1);
        q[k]! += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
        n[k]! += 1;
      }
    }
    return q.map((s, i) => s / Math.max(1, n[i]!) / 255);
  });
}

/** Wait for CONVERGENCE, not wall-clock. `waitForTimeout` would make the nest
 *  depth a function of the CI runner's frame rate; PURE TV is a contraction, so
 *  we can simply wait until the picture stops moving. */
async function waitConverged(canvas: Locator, page: Page, budgetMs = 12_000): Promise<void> {
  const t0 = Date.now();
  let prev = await centreRow(canvas);
  let stable = 0;
  while (Date.now() - t0 < budgetMs) {
    await page.waitForTimeout(220);
    const cur = await centreRow(canvas);
    if (cur.length && cur.length === prev.length) {
      let worst = 0;
      for (let i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs(cur[i]! - prev[i]!));
      if (worst < 3 / 255) { if (++stable >= 2) return; } else { stable = 0; }
    }
    prev = cur;
  }
  throw new Error(`PURE TV did not converge within ${budgetMs} ms — the nest never settled`);
}

/** Bezel bands on the right half of the centre row, by LOCAL contrast: a local
 *  minimum dipping >= 40 % below the mean of its two flanking local maxima.
 *  A "< 0.4 x row median" threshold would be source-brightness dependent. */
function bandCount(row: number[]): number {
  const half = row.slice(Math.floor(row.length / 2));
  let n = 0;
  for (let i = 1; i < half.length - 1; i++) {
    if (!(half[i]! <= half[i - 1]! && half[i]! < half[i + 1]!)) continue;
    let l = i; while (l > 0 && half[l - 1]! >= half[l]!) l--;
    let r = i; while (r < half.length - 1 && half[r + 1]! >= half[r]!) r++;
    const flank = (half[l]! + half[r]!) / 2;
    if (flank > 1e-6 && half[i]! <= 0.6 * flank) n++;
  }
  return n;
}

/** E1's log-radial autocorrelation, corrected per the design review: sample a
 *  RAY (not a circular annulus — at 4:3 an annulus carries a second periodicity
 *  at ln(aspect) that coincides with ln(1/s) by arithmetic accident at s=0.75),
 *  with the step DERIVED FROM THE FILL so the expected lag is exactly 12 at
 *  every fill, and DETRENDED so the g^k brightness ramp cannot survive
 *  normalisation and swamp the periodicity. Returns { lag, corr }; lag = -1
 *  means "no interior local maximum", which is a DEFINED failure, never a
 *  sentinel to compare numerically. */
function logRadialPeak(row: number[], fill: number): { lag: number; corr: number } {
  const N = 96, D = Math.log(1 / fill) / 12;
  const cx = row.length / 2;
  const prof: number[] = [];
  for (let j = 0; j < N; j++) {
    // r = (half-width) * exp(-j*D): walk INWARD from the frame edge in equal
    // log steps, so one nesting level is exactly 12 samples.
    const r = (row.length / 2 - 1) * Math.exp(-j * D);
    const x = Math.min(row.length - 1, Math.max(0, Math.round(cx + r)));
    prof.push(row[x]!);
  }
  // Least-squares detrend (remove the linear-in-j component).
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let j = 0; j < N; j++) { sx += j; sy += prof[j]!; sxx += j * j; sxy += j * prof[j]!; }
  const slope = (N * sxy - sx * sy) / Math.max(1e-9, N * sxx - sx * sx);
  const icept = (sy - slope * sx) / N;
  const y = prof.map((v, j) => v - (slope * j + icept));
  const ac = (k: number): number => {
    let num = 0, d0 = 0, d1 = 0;
    for (let j = 0; j + k < N; j++) { num += y[j]! * y[j + k]!; d0 += y[j]! ** 2; d1 += y[j + k]! ** 2; }
    return num / Math.sqrt(Math.max(1e-12, d0 * d1));
  };
  let lag = -1, best = -2;
  for (let k = 6; k <= 20; k++) {
    if (ac(k) > ac(k - 1) && ac(k) >= ac(k + 1) && ac(k) > best) { best = ac(k); lag = k; }
  }
  return { lag, corr: lag > 0 ? best : 0 };
}

// SHAPES, not a plasma: it is STATIC, so "converged" means converged rather
// than "the animated room happened to hold still", and it gives a room annulus
// of 1.000 with metres of headroom over E1's derived 0.35 precondition.
// (acidwarp measures 0.459 flat-averaged but ANIMATES, so the room brightness —
// and therefore the whole cascade — drifts under the assertions. A real flake.)
const ROOM_SRC = {
  id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video' as const,
  params: { shape: 0, zoom: 1.6 },
};
const OUT = { id: 'v-out', type: 'videoOut', position: { x: 980, y: 80 }, domain: 'video' as const };
const WIRES = [
  { id: 'e_a', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
  { id: 'e_o', from: { nodeId: 'bd', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
];

const TV_BASE = {
  tvMode: 1, feedback: 0.85, delay: 16, room: 1, bezel: 0.4, phosphor: 0,
  zoom: 1, rotate: 0, flicker: 0, pixelate: 1, mix: 0,
};

test.describe('BACKDRAFT PURE TV — the GPU renders a bounded screen', () => {
  test('E6 — WHITE-OUT is reachable by LUMA / FEEDBACK, and recoverable', async ({ page, rack }) => {
    // The owner's requirement, on the GPU: there is no feedback worth riding
    // without an uncontrollable zone to ride toward. An earlier revision
    // clamped the operator norm so this was impossible — that clamp is gone.
    const blownFraction = async (): Promise<number> => canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let hot = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) { if (d[i]! >= 230) hot++; n++; }
      return hot / n;
    });

    await spawnPatch(page, [
      ROOM_SRC,
      { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params: TV_BASE },
      OUT,
    ], WIRES);
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await waitConverged(canvas, page);
    const calm = await blownFraction();

    const set = async (patch: Record<string, number>): Promise<void> => {
      await page.evaluate((pp) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['bd'];
          if (n) for (const [k, v] of Object.entries(pp)) n.params[k] = v;
        });
      }, patch);
      await page.waitForTimeout(1400);
    };

    // Crank LUMA -> blows out.
    await set({ luma: 2 });
    const hotLuma = await blownFraction();
    expect(hotLuma, `LUMA 2 blows out (calm ${calm.toFixed(3)} -> ${hotLuma.toFixed(3)})`)
      .toBeGreaterThan(calm + 0.15);

    // FEEDBACK to max with LUMA positive -> blows out.
    await set({ luma: 1, feedback: 2 });
    const hotFb = await blownFraction();
    expect(hotFb, `FEEDBACK max blows out (${hotFb.toFixed(3)})`).toBeGreaterThan(calm + 0.15);

    // RECOVERABLE: back both off and the nest returns — not a wedge.
    await set({ luma: 1, feedback: 0.85 });
    await waitConverged(canvas, page);
    const recovered = await blownFraction();
    expect(Math.abs(recovered - calm), 'the nest comes back after the over-drive')
      .toBeLessThan(0.1);
    expect(bandCount(await centreRow(canvas)), 'bands are back').toBeGreaterThanOrEqual(3);
  });

  test('E1/E2/E3 — the nest is periodic in log-radius, banded, and monotone', async ({ page, rack, errorWatch }) => {
    await spawnPatch(page, [
      ROOM_SRC,
      { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params: TV_BASE },
      OUT,
    ], WIRES);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await waitConverged(canvas, page);
    const row = await centreRow(canvas);
    expect(row.length).toBeGreaterThan(64);

    // PRECONDITION, derived not guessed: with the room-proportional plateau the
    // k-th brightness step is 0.0626*R, so R >= 0.125 is the hard floor for
    // E3's 2/255. Assert the ROOM annulus actually clears 0.35 — if the chosen
    // source is too dim, E3 fails for a reason that has nothing to do with the
    // feature and this says so out loud.
    const edge = row.slice(Math.floor(row.length * 0.94));
    const roomMean = edge.reduce((a, b) => a + b, 0) / edge.length;
    expect(roomMean, 'room annulus is bright enough for the cascade to resolve').toBeGreaterThan(0.35);

    // E2 — bezel bands, by LOCAL contrast.
    expect(bandCount(row), 'resolved bezel bands on the centre row').toBeGreaterThanOrEqual(5);

    // E1 — log-radial periodicity at exactly one nesting level per 12 samples.
    const { lag, corr } = logRadialPeak(row, 0.75);
    expect(lag, 'a log-radial period exists (lag = -1 means no interior peak)').toBeGreaterThan(0);
    expect(Math.abs(lag - 12), `log-radial lag ${lag} should be 12 +/- 1`).toBeLessThanOrEqual(1);
    expect(corr, `log-radial autocorrelation ${corr.toFixed(3)}`).toBeGreaterThan(0.4);

    // E3 — brightness falls monotonically inward, by at least 2/255 a level.
    const cx = row.length / 2;
    const levels: number[] = [];
    for (let k = 0; k < 5; k++) {
      // Sample mid-annulus between the level-k and level-(k+1) picture edges.
      const rOuter = (cx - 1) * Math.pow(0.75, k);
      const rInner = (cx - 1) * Math.pow(0.75, k + 1);
      const r = (rOuter + rInner) / 2;
      let s = 0, n = 0;
      for (let d = -2; d <= 2; d++) {
        const x = Math.min(row.length - 1, Math.max(0, Math.round(cx + r + d)));
        s += row[x]!; n++;
      }
      levels.push(s / n);
    }
    for (let k = 1; k < levels.length; k++) {
      expect(levels[k]!, `level ${k} dimmer than level ${k - 1}`).toBeLessThan(levels[k - 1]! - 2 / 255);
    }
    expect(errorWatch.errors, 'no console errors').toEqual([]);
  });

  test('E4 — NEGATIVE CONTROL: the legacy composite does NOT nest', async ({ page, rack }) => {
    // zoom 0.8 so hasTransform is TRUE — the original zoom:1/rotate:0 control
    // makes the legacy path a pure additive clip, on which the peak-finder is
    // undefined and the assertion would pass by accident rather than on merit.
    await spawnPatch(page, [
      ROOM_SRC,
      { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
        params: { ...TV_BASE, tvMode: 0, zoom: 0.8 } },
      OUT,
    ], WIRES);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(1500);
    const row = await centreRow(canvas);

    expect(bandCount(row), 'the legacy plane has no bezel bands').toBeLessThan(2);
    const { lag, corr } = logRadialPeak(row, 0.75);
    // Either there is no interior peak at all, or it is far too weak to be a nest.
    expect(lag === -1 || corr < 0.35, `legacy lag=${lag} corr=${corr.toFixed(3)}`).toBe(true);
  });

  test('E5 — OFF is inert: the new params change NOTHING while TV MODE is off', async ({ page, rack }) => {
    // The design deliberately does NOT claim byte-identity to main (backdraft
    // has no pixel gate anywhere, so it is not provable here). What IS provable,
    // and is the realistic failure, is that the five new params are completely
    // inert while the mode is off — i.e. nothing leaked out of the branch.
    const read = async (params: Record<string, number>): Promise<number[]> => {
      await spawnPatch(page, [
        ROOM_SRC,
        { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params },
        OUT,
      ], WIRES);
      const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
      await expect(canvas).toHaveCount(1);
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.freeze = 1; });
      });
      await page.waitForTimeout(200);
      return quadrants(canvas);
    };

    const off = { ...TV_BASE, tvMode: 0, zoom: 0.8, pixelate: 0 };
    const a = await read(off);
    // Wildly different values for every new param — all must be ignored.
    const b = await read({ ...off, room: 0.05, bezel: 1, phosphor: 1, drive: 1 });
    expect(a.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(a[i]! - b[i]!), `quadrant ${i} unchanged by the TV params while OFF`)
        .toBeLessThan(2 / 255);
    }
  });

  test('CRITICAL — it breathes at high DRIVE, is still at low DRIVE, and recovers', async ({ page, rack }) => {
    // The CPU mirror proves the limit cycle with the noise floor OFF (C1/C2);
    // this only has to show the GPU servo is alive and, crucially, RECOVERABLE.
    await spawnPatch(page, [
      ROOM_SRC,
      { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
        params: { ...TV_BASE, tvMode: 2, drive: 0.85 } },
      OUT,
    ], WIRES);
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(2500);

    // Breathing: the FRAME MEAN moves. Sample CONSECUTIVE frames via rAF in a
    // single evaluate — the servo's limit cycle has a period of 2-3 FRAMES, so
    // polling from the test side every ~120 ms (7+ frames) ALIASES and can land
    // on the same phase every time, reading a swing of 0 on a picture that is
    // visibly pumping. That aliasing was a real 1-in-3 flake here.
    const means = await canvas.evaluate((el) => new Promise<number[]>((resolve) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) { resolve([]); return; }
      const out: number[] = [];
      const tick = (): void => {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let s = 0, n = 0;
        for (let i = 0; i < d.length; i += 64) { s += d[i]!; n++; }
        out.push(s / n / 255);
        if (out.length >= 40) resolve(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    expect(means.length, 'captured consecutive frames').toBeGreaterThan(20);
    const swing = Math.max(...means) - Math.min(...means);
    expect(swing, `CRITICAL frame-mean swing ${swing.toFixed(4)}`).toBeGreaterThan(0.01);

    // RECOVERABILITY — the safety property that replaces stability. Back DRIVE
    // off and the picture must settle again, with no wedge and no reload.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.drive = 0; });
    });
    await waitConverged(canvas, page);
    const settled = await centreRow(canvas);
    expect(settled.length).toBeGreaterThan(64);
    // …and it is a real nest again, not a white-out it never came back from.
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    expect(mean, 'recovered from the drive, not pinned at white').toBeLessThan(0.98);
    expect(bandCount(settled), 'the nest is back after backing DRIVE off').toBeGreaterThanOrEqual(3);
  });
});
