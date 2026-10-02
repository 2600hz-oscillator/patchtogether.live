// EDGEFADER — the owner's request, proven on the REAL chain: two real video
// sources (SHAPES, one filled circle → IN A; LINES, horizontal stripes → IN B)
// → EDGEFADER → the engine's output FBO, read back band by band. Nothing here
// drives the module class directly or trusts the CPU mirror: every picture
// claim is a gl.readPixels of what the module rendered, and every param claim
// is readParam on the live engine handle after a real Y.Doc write or a real
// audio-graph CV cable.
//
// What each leg proves, and how strong each claim is:
//   a. ENDPOINTS + CASCADE. Fader 0 renders IN A and fader 1 renders IN B, band
//      for band, within 1.5 levels of 255 — EXACT BY CONSTRUCTION: at either
//      endpoint every pixel's blend is 0 or 1 and its blur radius is 0, so the
//      composite is one texture fetch at the texel centre of the source (the
//      1.5 is RGBA8 round-trip slack, not a tolerance on the law). At fader 0.5
//      the cascade is read two ways: the engine's own `read('cascade')` — the
//      band-centre law, EXACT ([1, 1, 0.5, 0, 0]; [0.5, 0, 0, 0, 0] at 1/6) —
//      and the picture's per-band fraction toward B, which is an ORDERING plus
//      FLOORS (top band ≥ 0.9, bottom band ≤ 0.03, non-increasing top → bottom)
//      because the bottom quarter of every band ramps its window start to the
//      next band's (a hand-over, not a seam), so a band's lowest rows lag its
//      unit part and a band is "fully B" only once the band below it is through.
//   b. CV ROUTES THE THREE INPUTS. One real +0.5 CV (DEPOLARIZER at depth 0
//      through UNITYSCALEMATHEMATIK's attenuverter) fanned into the fader,
//      threshold and thickness jacks: readParam shows the linear cv-scale law
//      (knob + cv · half-span, clamped — lib/audio/cv-scale.ts) EXACTLY in both
//      polarities, the picture moves with the polarity (a FLOOR), the Y.Doc
//      keeps the manual knobs, and unplugging restores them (EXACT).
//   c. MELT. At fader 0.5 the toggle changes the picture in the bands that are
//      mid-cascade (FLOORS on the per-strip deltas of bands 1–3, read at four
//      strips per band because a band MEAN cannot see a slide within the band)
//      and NOT in the band that is already B (band 0) or still A (band 4) —
//      EXACT; the endpoints stay exact with melt on; the GATE jack engages the
//      melt with the toggle still 0 and its picture equals the toggled one
//      (EXACT — the same uniform), then disengages when the level drops.
//   d. FACE. The dock mounts the module's own output body and its four
//      controls; the fader drag writes params.fader and the MELT switch writes
//      params.melt.
//
// ⚠ FILENAME: `edgefader.spec.ts` matches NO glob in e2e/webgl-heavy-globs.ts,
// deliberately. A heavy name is NOT a lane move — it DELETES the spec from PR
// coverage (the lane that ran the heavy set is gone). Keep it so.
//
// DRS (e2e/tests/_render-smoke.ts): installRenderSmokeHooks BEFORE page.goto
// pauses the engine's rAF loop and pins its clock, so the test owns the frame
// count and LINES (whose only clock read is its auto-scroll) is the same frame
// on every step. Every probe advances the paused engine through
// stepAndReadStats (steps 2) and reads the FBO ONCE inside that evaluate; the
// engine-side reads of a probe (params, cascade, meltActive, the Y.Doc params)
// are ONE page.evaluate; the only Playwright-side polling is expect.poll over
// an engine readParam (the fader-cv.spec.ts precedent). No waitForTimeout.

import { test, expect } from './_fixtures';
import type { Page, Locator } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';
import { SLOW_BOOT_TEST_TIMEOUT_MS, AUDIO_READY_MS, PLACEHOLDER_PAINT_MS } from '../_helpers/boot-budget';

const EF = 'ef';
/** Frames per probe — the DRS standard burst (fader-cv.spec.ts). */
const STEPS = 2;
/** RGBA8 round-trip slack for an exact-by-construction equality, in levels. */
const ENDPOINT_TOL = 1.5;
/** Below this A/B contrast (levels) a band cannot carry a fraction toward B. */
const MIN_CONTRAST = 4;
/** Horizontal strips per cascade band for the MELT leg (see that test). */
const STRIPS_PER_BAND = 4;
/** MELT floors over the strips of the mid-cascade bands, in levels: the
 *  summed |Δ| and the largest single-strip |Δ| between melt and blur at fader
 *  0.5. Measured 200 and 103 on the real chain under the band-unit law (the
 *  half-way band's vacated top strip shows the incoming stripes in place of
 *  the circle; the fully slid band's lowest strip reads B, sourced from its
 *  unit part, where the blur still ramps), so these sit at ~¼ of the
 *  measurement: floors on a deterministic frame, with room for renderer
 *  filtering. */
const MELT_STRIP_SUM_MIN = 50;
const MELT_STRIP_MAX_MIN = 25;

/** Per-test budget, scaled by the number of PROBES the test makes — a probe
 *  is two synchronous steps of the six-pass engine-res pipeline plus one
 *  engine-res readback, which is what costs on CI's SwiftShader. One boot
 *  budget for the boot plus one more per four probes. A BOUND, never an
 *  assertion: it costs wall-clock only when it is exceeded. */
const probeBudget = (probes: number): number => SLOW_BOOT_TEST_TIMEOUT_MS * (1 + Math.ceil(probes / 4));

// ── the chain ───────────────────────────────────────────────────────────────

function chainNodes(efParams: Record<string, number>): SpawnNode[] {
  return [
    // A: one filled circle (no tiling) — a closed contour in the middle bands,
    // nothing in the top or bottom band.
    { id: 'srcA', type: 'shapes', domain: 'video', position: { x: 40, y: 40 }, params: { shape: 0, tile: 0, zoom: 0.6 } },
    // B: horizontal stripes — structure in every band; frame-stable under the
    // pinned clock (its only clock read is the auto-scroll phase).
    { id: 'srcB', type: 'lines', domain: 'video', position: { x: 40, y: 260 }, params: { orient: 0, amp: 6, thickness: 0.5 } },
    { id: EF, type: 'edgefader', domain: 'video', position: { x: 460, y: 120 }, params: efParams },
    { id: 'vout', type: 'videoOut', domain: 'video', position: { x: 900, y: 120 } },
  ];
}
function chainEdges(): SpawnEdge[] {
  return [
    { id: 'e-a', from: { nodeId: 'srcA', portId: 'out' }, to: { nodeId: EF, portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-b', from: { nodeId: 'srcB', portId: 'out' }, to: { nodeId: EF, portId: 'in_b' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-o', from: { nodeId: EF, portId: 'out' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
}

// ── engine-side reads: ONE evaluate per probe ───────────────────────────────

interface EngineProbe {
  audioState: string;
  params: Record<string, number | undefined>;
  cascade: number[] | null;
  meltActive: number | null;
  patchParams: Record<string, number> | null;
}

function engineRead(page: Page, nodeId: string, params: readonly string[]): Promise<EngineProbe> {
  return page.evaluate(({ nodeId, params }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => { ctx?: AudioContext; readParam?: (id: string, p: string) => number | undefined };
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      };
      __patch: { nodes: Record<string, { id: string; type: string; domain: string; params?: Record<string, number> } | undefined> };
    };
    const eng = w.__engine();
    const audio = eng.getDomain('audio');
    const vid = eng.getDomain('video');
    const node = w.__patch.nodes[nodeId];
    const out: Record<string, number | undefined> = {};
    for (const p of params) out[p] = vid.readParam?.(nodeId, p);
    return {
      audioState: audio.ctx?.state ?? 'none',
      params: out,
      cascade: node ? ((eng.read(node, 'cascade') as number[] | undefined) ?? null) : null,
      meltActive: node ? ((eng.read(node, 'meltActive') as number | undefined) ?? null) : null,
      patchParams: node?.params ? { ...node.params } : null,
    };
  }, { nodeId, params });
}

const round3 = (v: number | undefined): number | undefined => (v === undefined ? undefined : Math.round(v * 1000) / 1000);

type Expectation = number | ((v: number | undefined) => boolean);

/** Advance the paused engine and poll EDGEFADER's handle until every named
 *  param reads as expected (a number → equal to 3 decimals; a predicate →
 *  true) with the audio graph running. The CV bridges tick inside step(), and
 *  a Y.Doc write reaches the handle through the reconciler, so each iteration
 *  steps first and reads second. Returns the probe that satisfied the poll —
 *  its cascade / meltActive / Y.Doc params were read in the SAME evaluate. */
async function settle(page: Page, expected: Record<string, Expectation>, message: string): Promise<EngineProbe> {
  const keys = Object.keys(expected);
  const want: Record<string, number | boolean | string | undefined> = { audio: 'running' };
  for (const k of keys) {
    const e = expected[k]!;
    want[k] = typeof e === 'number' ? round3(e) : true;
  }
  let last: EngineProbe | null = null;
  await expect.poll(async () => {
    await stepAndReadStats(page, { nodeId: EF, steps: STEPS });
    last = await engineRead(page, EF, keys);
    const got: Record<string, number | boolean | string | undefined> = { audio: last.audioState };
    for (const k of keys) {
      const e = expected[k]!;
      const v = last.params[k];
      got[k] = typeof e === 'number' ? round3(v) : e(v);
    }
    return got;
  }, { timeout: AUDIO_READY_MS, message }).toEqual(want);
  return last!;
}

/** Read one node's per-band means off its output FBO after a fixed burst.
 *
 *  The node is marked WATCHED immediately before the burst: pull evaluation
 *  draws only what a watch mark younger than the engine's TTL reaches, and
 *  `outputTexture()` is that mark — but stepAndReadStats takes it AFTER its
 *  steps, so a lone read whose previous mark had expired would step frames
 *  this node was skipped in and hand back the frame before. Marking first
 *  makes the burst draw this node and, reverse-reachably, its sources. */
async function readBands(page: Page, nodeId: string, bands: number): Promise<number[]> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => { outputTexture: (id: string) => unknown } } };
    w.__engine().getDomain('video').outputTexture(id);
  }, nodeId);
  const s = await stepAndReadStats(page, { nodeId, steps: STEPS, bands });
  assertRenderStats(s, STEPS);
  expect(s.bandMeans, `${nodeId}: per-band means present`).toHaveLength(bands);
  return s.bandMeans!;
}

const fmt = (xs: readonly (number | null)[]): string => `[${xs.map((x) => (x === null ? 'skip' : x.toFixed(2))).join(', ')}]`;

/** Every band of `got` within `tol` levels of `want`. */
function expectBandsWithin(got: number[], want: number[], tol: number, message: string): void {
  const deltas = got.map((g, k) => g - want[k]!);
  expect(
    Math.max(...deltas.map(Math.abs)),
    `${message}: got ${fmt(got)} vs ${fmt(want)} → deltas ${fmt(deltas)} (tolerance ${tol})`,
  ).toBeLessThanOrEqual(tol);
}

/** Per-band fraction of the way from A to B, or null where the band's A/B
 *  contrast is below MIN_CONTRAST (no fraction can be read off it). */
function fractionsTowardB(out: number[], A: number[], B: number[]): (number | null)[] {
  return out.map((o, k) => {
    const span = B[k]! - A[k]!;
    return Math.abs(span) < MIN_CONTRAST ? null : (o - A[k]!) / span;
  });
}

async function addEdges(page: Page, edges: SpawnEdge[]): Promise<void> {
  // The same record shape spawnPatch writes, in one transaction.
  await page.evaluate((es) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const e of es) {
        w.__patch.edges[e.id] = {
          id: e.id,
          source: e.from,
          target: e.to,
          sourceType: e.sourceType ?? 'audio',
          targetType: e.targetType ?? 'audio',
        };
      }
    });
  }, edges);
}

async function deleteEdges(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((es) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => { for (const id of es) delete w.__patch.edges[id]; });
  }, ids);
}

function param(page: Page, id: string, name: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, name }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      return w.__patch.nodes[id]?.params?.[name];
    },
    { id, name },
  );
}

/** Pointer-drag a dock slider vertically (fader.spec.ts's helper, copied).
 *
 *  ⚠ `scrollIntoViewIfNeeded()` IS DELIBERATELY NOT USED. It is an
 *  ACTIONABILITY call: before scrolling it waits for the element to be STABLE
 *  — the same bounding box across two animation frames — and that wait carries
 *  NO timeout of its own, so it is bounded only by the test budget. The dock
 *  body here is a live video surface whose rAF loop keeps the pane painting,
 *  and on a loaded SwiftShader runner the box does not settle inside the
 *  budget: fader.spec.ts's CI failure was 31.7 s spent inside that one call on
 *  a page that was fully rendered the whole time. `scrollIntoView` via
 *  `evaluate` is the DOM call underneath it with no actionability contract, so
 *  the scroll happens on the first tick and the test still drives a REAL
 *  pointer at the REAL element afterwards. */
async function dragSlider(page: Page, slider: Locator, dyPx: number): Promise<void> {
  await slider.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await slider.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dyPx, { steps: 8 });
  await page.mouse.up();
}

// ── the tests ───────────────────────────────────────────────────────────────

test.describe('EDGEFADER — two real sources → edge-led cascade → engine FBO', () => {
  test('ENDPOINTS + CASCADE: fader 0 is IN A, fader 1 is IN B, and 0.5 is the band-centre cascade', async ({ page, errorWatch }) => {
    // Probes: 4 settles, A, B, 3 EDGEFADER reads.
    test.setTimeout(probeBudget(9));
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await spawnPatch(page, chainNodes({ fader: 0 }), chainEdges());

    const at0 = await settle(page, { fader: 0 }, 'engine up with the fader at 0 on the handle');
    // The band count comes from the engine's own cascade — never hand-typed.
    const bands = at0.cascade!.length;
    expect(bands, 'the cascade has bands').toBeGreaterThan(1);

    const A = await readBands(page, 'srcA', bands);
    const B = await readBands(page, 'srcB', bands);
    // Instrument control: the two sources must disagree somewhere, or
    // "out == A" and "out == B" would both be vacuous.
    expect(
      Math.max(...A.map((a, k) => Math.abs(a - B[k]!))),
      `A ${fmt(A)} and B ${fmt(B)} differ in at least one band`,
    ).toBeGreaterThan(MIN_CONTRAST * 4);

    const out0 = await readBands(page, EF, bands);
    expectBandsWithin(out0, A, ENDPOINT_TOL, 'fader 0 renders IN A band for band');

    await setNodeParams(page, EF, { fader: 1 });
    const at1 = await settle(page, { fader: 1 }, 'fader 1 on the handle');
    const out1 = await readBands(page, EF, bands);
    expectBandsWithin(out1, B, ENDPOINT_TOL, 'fader 1 renders IN B band for band');
    for (const [k, p] of at1.cascade!.entries()) expect(p, `cascade band ${k} complete at fader 1`).toBeCloseTo(1, 6);

    await setNodeParams(page, EF, { fader: 0.5 });
    const atHalf = await settle(page, { fader: 0.5 }, 'fader 0.5 on the handle');
    // The band-centre law for the owner's five bands: band k's window starts
    // at k/6 and lasts 1/3, so at 0.5 the top two are through, the middle is
    // half-way and the bottom two have not started.
    const lawAtHalf = [1, 1, 0.5, 0, 0];
    expect(atHalf.cascade, 'cascade is the band-centre law').toHaveLength(lawAtHalf.length);
    for (const [k, p] of lawAtHalf.entries()) expect(atHalf.cascade![k], `cascade band ${k} at fader 0.5`).toBeCloseTo(p, 6);

    const outHalf = await readBands(page, EF, bands);
    const f = fractionsTowardB(outHalf, A, B);
    const where = `out ${fmt(outHalf)}, A ${fmt(A)}, B ${fmt(B)} → fractions toward B ${fmt(f)} (a band is skipped where |B−A| < ${MIN_CONTRAST} levels)`;
    const top = f[0];
    const bottom = f[bands - 1];
    expect(top, `top band readable: ${where}`).not.toBeNull();
    expect(bottom, `bottom band readable: ${where}`).not.toBeNull();
    expect(top!, `top band is (near) fully B at fader 0.5: ${where}`).toBeGreaterThanOrEqual(0.9);
    expect(bottom!, `bottom band is still A at fader 0.5: ${where}`).toBeLessThanOrEqual(0.03);
    // Non-increasing top → bottom across the readable bands, 0.05 slack: the
    // ripple runs DOWN the picture.
    const readable = f.filter((x): x is number => x !== null);
    for (let i = 1; i < readable.length; i++) {
      expect(readable[i]!, `fraction toward B never rises going down the picture: ${where}`)
        .toBeLessThanOrEqual(readable[i - 1]! + 0.05);
    }

    await setNodeParams(page, EF, { fader: 1 / 6 });
    const atSixth = await settle(page, { fader: 1 / 6 }, 'fader 1/6 on the handle');
    const lawAtSixth = [0.5, 0, 0, 0, 0];
    for (const [k, p] of lawAtSixth.entries()) expect(atSixth.cascade![k], `cascade band ${k} at fader 1/6`).toBeCloseTo(p, 6);
  });

  test('CV ROUTES THE THREE INPUTS: the linear cv-scale law on fader, threshold and thickness; the Y.Doc keeps the knobs; unplug restores', async ({ page, errorWatch }) => {
    // Probes: 3 settles + 2 EDGEFADER reads.
    test.setTimeout(probeBudget(5));
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await spawnPatch(page, [
      ...chainNodes({ fader: 0.25, threshold: 0.2, thickness: 2 }),
      { id: 'dc', type: 'depolarizer', position: { x: 40, y: 480 }, params: { depth: 0 } }, // a genuine +0.5 CV
      { id: 'pol', type: 'unityscalemathematik', position: { x: 300, y: 480 }, params: { unityAtten: 1 } },
    ], [
      ...chainEdges(),
      { id: 'dc-pol', from: { nodeId: 'dc', portId: 'out' }, to: { nodeId: 'pol', portId: 'u_in' }, sourceType: 'cv', targetType: 'cv' },
      // One cv output fanned to the three jacks — each gets its own bridge.
      { id: 'cv-fader', from: { nodeId: 'pol', portId: 'u_out' }, to: { nodeId: EF, portId: 'fader' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'cv-threshold', from: { nodeId: 'pol', portId: 'u_out' }, to: { nodeId: EF, portId: 'threshold' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'cv-thickness', from: { nodeId: 'pol', portId: 'u_out' }, to: { nodeId: EF, portId: 'thickness' }, sourceType: 'cv', targetType: 'cv' },
    ]);

    // +0.5 · half-span: 0.25 + 0.25, 0.2 + 0.25, 2 + 0.5 · 3.5.
    const plus = await settle(page, { fader: 0.5, threshold: 0.45, thickness: 3.75 }, '+0.5 CV through the linear cv-scale law');
    const bands = plus.cascade!.length;
    const high = await readBands(page, EF, bands);
    const manual = { fader: 0.25, threshold: 0.2, thickness: 2 };
    expect(plus.patchParams, 'CV never writes its transient value into the saved patch').toMatchObject(manual);

    await setNodeParams(page, 'pol', { unityAtten: -1 });
    // −0.5 · half-span: fader and threshold clamp at 0, thickness at its 1 px floor.
    const minus = await settle(page, { fader: 0, threshold: 0, thickness: 1 }, '−0.5 CV through the linear cv-scale law, clamped');
    const low = await readBands(page, EF, bands);
    expect(minus.patchParams, 'CV never writes its transient value into the saved patch').toMatchObject(manual);

    // The picture moved with the polarity: the fader went 0.5 → 0, so the top
    // band went from B to A (and band 1 with it).
    expect(
      Math.max(Math.abs(high[0]! - low[0]!), Math.abs(high[1]! - low[1]!)),
      `the picture follows the CV: +0.5 ${fmt(high)} vs −0.5 ${fmt(low)}`,
    ).toBeGreaterThanOrEqual(3);

    await deleteEdges(page, ['cv-fader', 'cv-threshold', 'cv-thickness']);
    await settle(page, manual, 'unplugging the three cables restores the manual knobs');
  });

  test('MELT: the toggle changes the mid-cascade bands only, keeps the endpoints exact, and the gate engages it without the toggle', async ({ page, errorWatch }) => {
    // Probes: 7 settles, A, B, 5 EDGEFADER reads.
    test.setTimeout(probeBudget(14));
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await spawnPatch(page, [
      ...chainNodes({ fader: 0.5, melt: 0 }),
      // The gate level: DEPOLARIZER at depth 0 is +0.5; two more at depth 1
      // (out = 0.5 + in/2) lift it to 0.75 then 0.875, so the level sits
      // clearly above the 0.5 melt threshold and clearly below it inverted.
      { id: 'dc', type: 'depolarizer', position: { x: 40, y: 480 }, params: { depth: 0 } },
      { id: 'dep2', type: 'depolarizer', position: { x: 260, y: 480 }, params: { depth: 1 } },
      { id: 'dep3', type: 'depolarizer', position: { x: 480, y: 480 }, params: { depth: 1 } },
      { id: 'pol', type: 'unityscalemathematik', position: { x: 700, y: 480 }, params: { unityAtten: 1 } },
    ], [
      ...chainEdges(),
      { id: 'dc-dep2', from: { nodeId: 'dc', portId: 'out' }, to: { nodeId: 'dep2', portId: 'in' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'dep2-dep3', from: { nodeId: 'dep2', portId: 'out' }, to: { nodeId: 'dep3', portId: 'in' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'dep3-pol', from: { nodeId: 'dep3', portId: 'out' }, to: { nodeId: 'pol', portId: 'u_in' }, sourceType: 'cv', targetType: 'cv' },
      // The gate cable itself is patched LATER, once the toggle leg is done.
    ]);

    const off = await settle(page, { fader: 0.5, melt: 0 }, 'engine up, fader 0.5, MELT off');
    expect(off.meltActive, 'meltActive 0 with the toggle off and no gate').toBe(0);
    const bands = off.cascade!.length;
    // ⚠ STRIPS, NOT BANDS, for the melt. A per-band MEAN is blind to a
    // vertical slide WITHIN the band by construction — it sees only the rows
    // the slide vacates at the band's top and the drip across the boundary
    // below, a few levels at most with these sources. Four strips per band
    // (the count derived from the cascade, never typed) see the content move:
    // the slid band's lower strips show what was above them and the half-way
    // band's top strip shows the incoming frame. Bands 0 and 4 keep their
    // exactness claim strip for strip.
    const strips = bands * STRIPS_PER_BAND;
    const stripBand = (i: number): number => Math.floor(i / STRIPS_PER_BAND);
    const A = await readBands(page, 'srcA', strips);
    const B = await readBands(page, 'srcB', strips);
    const blur = await readBands(page, EF, strips);

    await setNodeParams(page, EF, { melt: 1 });
    const on = await settle(page, { melt: 1 }, 'MELT toggle on the handle');
    expect(on.meltActive, 'meltActive 1 with the toggle on').toBe(1);
    const melt = await readBands(page, EF, strips);

    // Which bands CAN differ at fader 0.5, and why. Band 0's window is
    // closed (progress 1): its slide has landed and its drip into band 1 has
    // already faded to B, so it is B in both modes. Band 4's window has not
    // opened (progress 0) and band 3's drip has zero length at progress 0, so
    // it is A in both modes. Bands 1–3 are mid-cascade: band 1 has fully slid
    // (every row it still shows was sourced from its unit part, so it reads B
    // where the blur's bottom quarter still ramps), band 2 is half-way and
    // vacates its top rows while its content slides, and band 3 receives
    // band 2's drip — those are where a slide differs from a blur.
    const delta = melt.map((m, i) => m - blur[i]!);
    const edgeStrips = delta.filter((_, i) => stripBand(i) === 0 || stripBand(i) === bands - 1);
    expect(
      Math.max(...edgeStrips.map(Math.abs)),
      `band 0 is B and band ${bands - 1} is A in both modes: Δ per strip ${fmt(delta)}`,
    ).toBeLessThanOrEqual(ENDPOINT_TOL);
    const mid = delta.filter((_, i) => stripBand(i) > 0 && stripBand(i) < bands - 1);
    const where = `blur ${fmt(blur)} vs melt ${fmt(melt)} → Δ per strip ${fmt(delta)}`;
    expect(mid.reduce((acc, d) => acc + Math.abs(d), 0), `MELT moves the mid-cascade bands' content: ${where}`)
      .toBeGreaterThanOrEqual(MELT_STRIP_SUM_MIN);
    expect(Math.max(...mid.map(Math.abs)), `at least one mid-cascade strip shows slid content: ${where}`)
      .toBeGreaterThanOrEqual(MELT_STRIP_MAX_MIN);

    // Endpoints stay exact with MELT on.
    await setNodeParams(page, EF, { fader: 0 });
    await settle(page, { fader: 0, melt: 1 }, 'fader 0 with MELT on');
    expectBandsWithin(await readBands(page, EF, strips), A, ENDPOINT_TOL, 'MELT on, fader 0 renders IN A strip for strip');
    await setNodeParams(page, EF, { fader: 1 });
    await settle(page, { fader: 1, melt: 1 }, 'fader 1 with MELT on');
    expectBandsWithin(await readBands(page, EF, strips), B, ENDPOINT_TOL, 'MELT on, fader 1 renders IN B strip for strip');

    // Back to the mid-fade with the toggle OFF, then the GATE.
    await setNodeParams(page, EF, { fader: 0.5, melt: 0 });
    const offAgain = await settle(page, { fader: 0.5, melt: 0 }, 'MELT toggle off again');
    expect(offAgain.meltActive, 'meltActive 0 again').toBe(0);

    await addEdges(page, [
      { id: 'gate', from: { nodeId: 'pol', portId: 'u_out' }, to: { nodeId: EF, portId: 'melt_gate' }, sourceType: 'cv', targetType: 'gate' },
    ]);
    const gatedProbe = await settle(page, { melt: 0, meltGate: (v) => v !== undefined && v >= 0.75 }, 'the gate level (0.875) lands on meltGate with the toggle still 0');
    expect(gatedProbe.meltActive, 'the gate alone engages the melt').toBe(1);
    const gated = await readBands(page, EF, strips);
    // Same uniform (uMelt = 1) over the same inputs: the gated picture IS the
    // toggled picture.
    expectBandsWithin(gated, melt, 2, 'the gated picture equals the toggled picture strip for strip');

    await setNodeParams(page, 'pol', { unityAtten: -1 });
    const released = await settle(page, { melt: 0, meltGate: (v) => v !== undefined && v < 0.5 }, 'the gate level drops below the melt threshold');
    expect(released.meltActive, 'the melt disengages when the gate goes low').toBe(0);
    expect(released.patchParams!.melt, 'the toggle in the saved patch was never touched by the gate').toBe(0);
    expect(released.patchParams!.meltGate, 'the gate level never reaches the saved patch').toBeUndefined();
  });

  test('FACE: the dock mounts the output body and four controls; the fader drag and the MELT switch write params', async ({ page, errorWatch }) => {
    test.setTimeout(probeBudget(0));
    // The dock body is a live video surface. An idle engine keeps this DOM
    // test from being starved by the compositor on a loaded runner; the
    // claims here are about the face, not the picture.
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await spawnPatch(page, [{ id: EF, type: 'edgefader', domain: 'video', position: { x: 200, y: 120 } }]);

    const tile = page.locator(`.svelte-flow__node[data-id="${EF}"] [data-testid="module-shell"]`);
    await expect(tile).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    await tile.getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    await expect(dock.getByTestId('edgefader-output-body'), 'the module-owned output body mounts in the dock').toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    await expect(
      dock.locator('[data-testid="control-fader"], [data-testid="control-melt"], [data-testid="control-threshold"], [data-testid="control-thickness"]'),
      'the four declared controls are present',
    ).toHaveCount(4);

    // A/B fader → params.fader (drag up = raise; default 0.5).
    const before = (await param(page, EF, 'fader')) ?? 0.5;
    await dragSlider(page, dock.getByTestId('control-fader'), -40);
    await expect.poll(async () => ((await param(page, EF, 'fader')) ?? 0.5) > before, { message: 'A/B fader drag raises params.fader' })
      .toBe(true);

    // MELT is a 0/1 discrete param → a switch cell; clicking it latches the toggle.
    const melt = dock.getByTestId('control-melt');
    await expect(melt, 'MELT renders as a switch').toHaveAttribute('role', 'switch');
    await expect(melt, 'MELT starts off').toHaveAttribute('aria-checked', 'false');
    await melt.click();
    await expect.poll(() => param(page, EF, 'melt'), { message: 'MELT switch writes params.melt' }).toBe(1);
    await expect(melt, 'MELT reads on').toHaveAttribute('aria-checked', 'true');
  });
});
