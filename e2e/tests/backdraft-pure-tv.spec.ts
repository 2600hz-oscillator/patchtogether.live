// e2e/tests/backdraft-pure-tv.spec.ts
//
// BACKDRAFT PURE TV / CRITICAL — proves the GPU really renders the bounded
// screen. The GEOMETRY itself is proven in the GL-free CPU mirror
// (backdraft-tv.test.ts, N/C/R series); this spec only has to show that the
// shader agrees with it, plus that TV MODE = OFF leaves the legacy path alone.
//
// FRAMES ARE DRIVEN MANUALLY, never waited for. BACKDRAFT is an ITERATED
// feedback loop: the nest builds one level per frame, so what these assertions
// need is a frame COUNT. Waiting in milliseconds silently converts to a
// different number of frames on every renderer — measured, a real GPU runs this
// patch at ~60 fps, CI's SwiftShader at 7.9 fps single-threaded, and CI runs TEN
// e2e shards in parallel, which drove per-browser rAF to ~0.5-2 fps and timed
// the spec out. Pausing the rAF loop (`__videoEnginePause`) and calling `step()`
// ourselves with a PINNED clock makes the frame count exact and the wall-clock
// cost the renderer's true fill rate and nothing else. Established pattern —
// backdraft-render-smoke.spec.ts drives frames the same way.
//
// RENDERER TOLERANCE is deliberate throughout: every assertion is a ratio, a
// count, or a monotonicity over large-scale geometry — never a pixel value and
// never a filtering-sensitive quantity. The tap minifies by 1/s = 1.333 with
// LINEAR and no mipmaps, so SwiftShader and a real GPU diverge more with every
// one of the ~11 compounded resamples. No pixel-value assertion at depth.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

test.setTimeout(180_000);

interface Read {
  row: number[];      // centre row, 0..1
  quads: number[];    // 4 quadrant means, 0..1
  blown: number;      // fraction of samples >= 0.9
  means: number[];    // frame mean per captured frame (last N steps)
}

/** Step the video engine `steps` frames with a pinned clock, then read the
 *  BACKDRAFT node's own output texture. `capture` records the frame mean on
 *  each of the last N steps — used for the CRITICAL limit cycle, where the
 *  frames must be CONSECUTIVE. */
async function stepRead(
  page: Page,
  o: { steps: number; capture?: number; startTimeSec?: number },
): Promise<Read> {
  return page.evaluate(({ steps, capture, startTimeSec }) => {
    const w = globalThis as unknown as {
      __videoEnginePause?: boolean;
      __videoEngineFreezeTime?: number;
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    w.__videoEnginePause = true;
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    const bind = (): boolean => {
      const tex = vid.outputTexture('bd') as WebGLTexture | null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    };
    // A narrow column is enough for a frame MEAN and is far cheaper than a full
    // readback on every captured frame.
    const cw = Math.max(8, Math.floor(W * 0.15));
    const cx = Math.floor((W - cw) / 2);
    const colPx = new Uint8Array(cw * H * 4);
    const means: number[] = [];
    const capN = capture ?? 0;

    for (let n = 0; n < steps; n++) {
      w.__videoEngineFreezeTime = (startTimeSec ?? 0) + (n + 0.5) / 60;
      vid.step();
      if (capN > 0 && n >= steps - capN && bind()) {
        colPx.fill(0);
        gl.readPixels(cx, 0, cw, H, gl.RGBA, gl.UNSIGNED_BYTE, colPx);
        let s = 0, c = 0;
        for (let i = 0; i < colPx.length; i += 4) { s += colPx[i]!; c++; }
        means.push(s / c / 255);
      }
    }

    const row: number[] = [];
    const quads = [0, 0, 0, 0];
    const qn = [0, 0, 0, 0];
    let blownHot = 0, blownN = 0;
    if (bind()) {
      const rowPx = new Uint8Array(W * 4);
      gl.readPixels(0, Math.floor(H / 2), W, 1, gl.RGBA, gl.UNSIGNED_BYTE, rowPx);
      for (let x = 0; x < W; x++) row.push(rowPx[x * 4]! / 255);
      const all = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, all);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const k = (y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1);
          quads[k]! += (all[i]! + all[i + 1]! + all[i + 2]!) / 3;
          qn[k]! += 1;
          if (all[i]! >= 230) blownHot++;
          blownN++;
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return {
      row,
      quads: quads.map((v, i) => v / Math.max(1, qn[i]!) / 255),
      blown: blownHot / Math.max(1, blownN),
      means,
    };
  }, { steps: o.steps, capture: o.capture ?? 0, startTimeSec: o.startTimeSec ?? 0 });
}

async function setParams(page: Page, patch: Record<string, number>): Promise<void> {
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
 *  normalisation and swamp the periodicity. `lag = -1` means "no interior local
 *  maximum" — a DEFINED failure, never a sentinel to compare numerically. */
function logRadialPeak(row: number[], fill: number): { lag: number; corr: number } {
  const N = 96, D = Math.log(1 / fill) / 12;
  const cx = row.length / 2;
  const prof: number[] = [];
  for (let j = 0; j < N; j++) {
    const r = (row.length / 2 - 1) * Math.exp(-j * D);
    prof.push(row[Math.min(row.length - 1, Math.max(0, Math.round(cx + r)))]!);
  }
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

// SHAPES, not a plasma: it is STATIC, so the nest converges to a real fixed
// point rather than chasing an animated room, and it gives a room annulus of
// 1.000 with metres of headroom over E1's derived 0.35 precondition.
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
  // bezel 0.5 = the module's own default = mid-travel of the border fader. NOT
  // 0.4: the border remap (0 px at the bottom, shipped look re-centred) changed
  // what 0.4 MEANS -- tb went 0.06 -> 0.048, a thinner border, which resolves
  // fewer bands and dropped the recovery assertion to 2. Pin the default, not a
  // number that used to equal it.
  tvMode: 1, feedback: 0.85, delay: 16, room: 1, bezel: 0.5, phosphor: 0,
  zoom: 1, rotate: 0, flicker: 0, pixelate: 1, mix: 0,
};

/** The CPU mirror is bit-exactly still by frame ~80 at DELAY = 1 (one level per
 *  frame), and the deepest thing any assertion here reads is level 5. 45 is
 *  comfortably past both, and it is the SAME on every renderer because we drive
 *  the steps ourselves. Kept tight on purpose: this spec renders every frame it
 *  asks for, so frames are the budget. */
const NEST_FRAMES = 45;

async function spawn(page: Page, params: Record<string, number>): Promise<void> {
  await spawnPatch(page, [
    ROOM_SRC,
    { id: 'bd', type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params },
    OUT,
  ], WIRES);
  await expect(page.locator('.svelte-flow__node-backdraft')).toBeVisible();
}

test.describe('BACKDRAFT PURE TV — the GPU renders a bounded screen', () => {
  test('E1/E2/E3 — the nest is periodic in log-radius, banded, and monotone', async ({ page, rack, errorWatch }) => {
    await spawn(page, TV_BASE);
    const r = await stepRead(page, { steps: NEST_FRAMES });
    expect(r.row.length).toBeGreaterThan(64);

    // PRECONDITION, derived not guessed: with the room-proportional plateau the
    // k-th brightness step is 0.0626*R, so R >= 0.125 is the hard floor for
    // E3's 2/255. Assert the ROOM annulus clears 0.35 — if the chosen source is
    // too dim, E3 fails for a reason unrelated to the feature and this says so.
    const edge = r.row.slice(Math.floor(r.row.length * 0.94));
    const roomMean = edge.reduce((a, b) => a + b, 0) / edge.length;
    expect(roomMean, 'room annulus bright enough for the cascade to resolve').toBeGreaterThan(0.35);

    // E2 — bezel bands, by LOCAL contrast.
    expect(bandCount(r.row), 'resolved bezel bands on the centre row').toBeGreaterThanOrEqual(5);

    // E1 — log-radial periodicity at exactly one nesting level per 12 samples.
    const { lag, corr } = logRadialPeak(r.row, 0.75);
    expect(lag, 'a log-radial period exists (lag = -1 means no interior peak)').toBeGreaterThan(0);
    expect(Math.abs(lag - 12), `log-radial lag ${lag} should be 12 +/- 1`).toBeLessThanOrEqual(1);
    expect(corr, `log-radial autocorrelation ${corr.toFixed(3)}`).toBeGreaterThan(0.4);

    // E3 — brightness falls monotonically inward, by at least 2/255 a level.
    const cx = r.row.length / 2;
    const levels: number[] = [];
    for (let k = 0; k < 5; k++) {
      const rad = ((cx - 1) * Math.pow(0.75, k) + (cx - 1) * Math.pow(0.75, k + 1)) / 2;
      let s = 0, n = 0;
      for (let d = -2; d <= 2; d++) {
        s += r.row[Math.min(r.row.length - 1, Math.max(0, Math.round(cx + rad + d)))]!; n++;
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
    //
    // ⚠ THAT REMEDY DOES NOT ACTUALLY WORK, and the honest thing is to say so.
    // MEASURED at zoom 0.8 (SwiftShader, 45 frames): the legacy frame is
    // FULLY CLIPPED — mean 1.000, blown 1.000, centre-row variance 0.00000,
    // bands 0, lag -1. It is still a pure additive clip; the transform did not
    // rescue it. Sweeping FEEDBACK 0.85 → 0 does not change it either (mean
    // stays 1.000 at every value), because the room source itself
    // (shapes, zoom 1.6) is already a near-full-white field.
    //
    // So BOTH of this test's assertions are satisfied by a FLAT frame — and a
    // BLACK frame is flat too. As written it could not tell "the legacy path
    // does not nest" from "nothing rendered at all". The floor below closes
    // that specific hole: a dead render scores mean 0 and fails.
    //
    // What it deliberately does NOT do is assert STRUCTURE. There is none to
    // assert: a flat clipped field is the genuine legacy result for this scene.
    // The real contrast is with E1, which runs the IDENTICAL scene and source
    // at the same frame count and requires >= 5 resolved bands — the pair is
    // the control, not this test alone. ⚠ A stronger E4 would capture TV ON and
    // TV OFF in the same test and assert the difference directly; that costs a
    // second 45-frame render (~40 s of CI on the software renderer), which is
    // why it is called out here rather than done silently.
    await spawn(page, { ...TV_BASE, tvMode: 0, zoom: 0.8 });
    const r = await stepRead(page, { steps: NEST_FRAMES });

    // ANTI-VACUITY: the legacy path RENDERED something. Without this, a dead
    // render (all-black: no bands, no periodicity) passes this negative control.
    // Measured off the centre ROW, which bandCount/logRadialPeak already read —
    // so this costs no extra readback.
    const lit = r.row.reduce((a, b) => a + b, 0) / r.row.length;
    expect(lit, `the legacy composite rendered a frame (mean luma ${lit.toFixed(3)}) — ` +
      'a black frame has no bands and no periodicity either, and would pass vacuously')
      .toBeGreaterThan(0.02);

    expect(bandCount(r.row), 'the legacy plane has no bezel bands').toBeLessThan(2);
    const { lag, corr } = logRadialPeak(r.row, 0.75);
    expect(lag === -1 || corr < 0.35, `legacy lag=${lag} corr=${corr.toFixed(3)}`).toBe(true);
  });

  test('E5 — OFF is inert: the new params change NOTHING while TV MODE is off', async ({ page, rack }) => {
    // The design deliberately does NOT claim byte-identity to main (backdraft
    // has no pixel gate anywhere, so it is not provable here). What IS provable,
    // and is the realistic failure, is that the new params are completely inert
    // while the mode is off — i.e. nothing leaked out of the branch.
    const off = { ...TV_BASE, tvMode: 0, zoom: 0.8, pixelate: 0 };
    await spawn(page, off);
    const a = await stepRead(page, { steps: 40 });
    await setParams(page, { room: 0.05, bezel: 1, phosphor: 1, drive: 1 });
    const b = await stepRead(page, { steps: 40 });
    expect(a.quads.length).toBe(4);

    // ⚠ ANTI-VACUITY. Every assertion below is "these two frames are EQUAL",
    // and two BLACK frames are perfectly equal — so with the render dead this
    // test passed while proving nothing. Pin that there is a picture to be
    // inert ABOUT. (Measured for this scene: quadrant means ~0.98, a clipped
    // near-white field — so this is a floor against a dead render, not a
    // structure claim; see the E4 note for why structure is not assertable on
    // the legacy path with this source.)
    const litA = a.quads.reduce((x, y) => x + y, 0) / a.quads.length;
    expect(litA, `there IS a picture for the TV params to be inert about (mean luma ${litA.toFixed(3)}) — ` +
      'two black frames are equal, so without this the inertness claim is vacuous')
      .toBeGreaterThan(0.02);

    for (let i = 0; i < 4; i++) {
      expect(Math.abs(a.quads[i]! - b.quads[i]!), `quadrant ${i} unchanged by the TV params while OFF`)
        .toBeLessThan(2 / 255);
    }
  });

  test('E6 — WHITE-OUT is reachable by LUMA / FEEDBACK, and recoverable', async ({ page, rack }) => {
    // There is no feedback worth riding without an uncontrollable zone to ride
    // toward. An earlier revision clamped the operator norm so this was
    // impossible; that clamp is gone.
    await spawn(page, TV_BASE);
    const calm = (await stepRead(page, { steps: NEST_FRAMES })).blown;

    await setParams(page, { luma: 2 });
    const hotLuma = (await stepRead(page, { steps: 30 })).blown;
    expect(hotLuma, `LUMA 2 blows out (calm ${calm.toFixed(3)} -> ${hotLuma.toFixed(3)})`)
      .toBeGreaterThan(calm + 0.15);

    await setParams(page, { luma: 1, feedback: 2 });
    const hotFb = (await stepRead(page, { steps: 30 })).blown;
    expect(hotFb, `FEEDBACK max blows out (${hotFb.toFixed(3)})`).toBeGreaterThan(calm + 0.15);

    // RECOVERABLE: back both off and the nest returns — not a wedge.
    await setParams(page, { luma: 1, feedback: 0.85 });
    const back = await stepRead(page, { steps: NEST_FRAMES });
    expect(Math.abs(back.blown - calm), 'the nest comes back after the over-drive').toBeLessThan(0.1);
    expect(bandCount(back.row), 'bands are back').toBeGreaterThanOrEqual(3);
  });

  test('E7 — the VIRTUAL REFRESH: FLICKER cuts a seam the nest re-images', async ({ page, rack }) => {
    // The display is redrawn line by line, so the camera catches a SEAM between
    // two fields — and each nesting level re-photographs a screen that already
    // has one. FLICKER OFF must be the exact no-op; FLICKER ON must change the
    // picture without destroying the nest.
    await spawn(page, TV_BASE);
    const off = await stepRead(page, { steps: NEST_FRAMES });

    await setParams(page, { flicker: 1 });
    const on = await stepRead(page, { steps: NEST_FRAMES });

    const rowDelta = off.row.map((v, i) => Math.abs(v - (on.row[i] ?? v)));
    expect(Math.max(...rowDelta), 'the refresh changes the picture').toBeGreaterThan(2 / 255);
    expect(on.quads.every((q) => q > 0.01 && q < 0.995), 'still a real picture').toBe(true);
    expect(bandCount(on.row), 'the nest survives the refresh').toBeGreaterThanOrEqual(3);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the only proof that BACKDRAFT's GPU shader agrees with its GL-free CPU mirror — that the iterated feedback nest actually breathes under DRIVE, settles when DRIVE is low, and recovers afterwards.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('CRITICAL — it breathes at high DRIVE, is still at low DRIVE, and recovers', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
    // The CPU mirror proves the limit cycle with the noise floor OFF (C1/C2);
    // this only has to show the GPU servo is alive and, crucially, RECOVERABLE.
    await spawn(page, { ...TV_BASE, tvMode: 2, drive: 0.85 });
    // Frames are CONSECUTIVE by construction here, and that matters: the servo's
    // limit cycle has a period of 2-3 FRAMES, so any sampling that skips frames
    // aliases and can read the same phase every time — a swing of 0 on a
    // visibly pumping picture. That was a real 1-in-3 flake before the spec
    // drove its own steps.
    const hot = await stepRead(page, { steps: 130, capture: 30 });
    expect(hot.means.length, 'captured consecutive frames').toBeGreaterThanOrEqual(24);
    const swing = Math.max(...hot.means) - Math.min(...hot.means);
    expect(swing, `CRITICAL frame-mean swing ${swing.toFixed(4)}`).toBeGreaterThan(0.01);

    // RECOVERABILITY — the safety property that replaces stability. Back DRIVE
    // off and the picture must settle again, with no wedge and no reload.
    await setParams(page, { drive: 0 });
    // 140, not 90: after the servo has been hammering, the nest has to REBUILD
    // one level per frame from a disturbed state, so the recovery window cannot
    // be trimmed as hard as the others. Cutting it to 90 left only ~2 resolved
    // bands and failed on merit, not on flake.
    const settled = await stepRead(page, { steps: 140, capture: 12 });
    const calmSwing = Math.max(...settled.means) - Math.min(...settled.means);
    expect(calmSwing, `settled swing ${calmSwing.toFixed(4)}`).toBeLessThan(swing / 2);
    expect(settled.quads.every((q) => q < 0.995), 'recovered, not pinned at white').toBe(true);
    expect(bandCount(settled.row), 'the nest is back after backing DRIVE off').toBeGreaterThanOrEqual(3);
  });
});
