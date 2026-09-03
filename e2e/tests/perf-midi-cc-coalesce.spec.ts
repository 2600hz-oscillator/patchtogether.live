// e2e/tests/perf-midi-cc-coalesce.spec.ts
//
// Regression gate for the MIDI-CC → video-render starvation fix (the owner's
// "twisting Electra knobs murders video rendering" report, birds1 patch).
//
// MECHANISM (verified):
// every CC message used to run the RAW knob onchange → one ydoc.transact per
// message → a synchronous per-transaction cascade (whole-snapshot rebuild,
// full flowNodes/flowEdges rebuild into SvelteFlow, a reconciler pass that
// JSON round-tripped EVERY node's data blob, ~2 update pumps per mounted
// card). At 100–300 msg/s that starves the video rAF loop. Gamepad CV on the
// SAME params is free because it never writes the store per sample — the
// difference is the store write, not the message rate.
//
// FIX: the setter registered with midi-learn (midi-assignable.svelte.ts) and
// the Electra host writeParam path both ride createCcCommit — per message
// the value is pushed TRANSIENTLY into the engine (handle-local, zero-Y.Doc)
// while the durable store commit coalesces (leading edge + ≥150 ms gaps +
// a 200 ms trailing settle flush that always lands the FINAL value).
//
// WHAT WE ASSERT (deterministic, renderer-independent — the CI gate):
//   * A 100-message CC burst through the REAL card-mounted knob setter path
//     (importBindings → handleCc → setters.get(key) → the knob-registered
//     onchange — the identical path a learned binding takes) produces at
//     most `2 + ceil(streamMs / 150)` Y.Doc transactions (leading commit +
//     one per throttle window + settle flush), instead of ~1 per message.
//     Pinned for BOTH legs: a params-backed module (BACKDRAFT mix) and the
//     toybox DATA-write leg (layer:<i>:rotX → setLayerMaterialField).
//   * FINAL-VALUE CONVERGENCE: after the settle flush the store equals the
//     LAST sent CC's scaled value (collab peers / persistence contract), and
//     the toybox engine clone (read('liveModulated')) agrees.
//
// The FPS measurement is deliberately a LOG-ONLY diagnostic: CI's SwiftShader
// software renderer makes absolute-FPS asserts flaky (repo memory:
// capability/renderer-dependent e2e), while the transaction-count invariant
// above pins the starvation mechanism deterministically — the same approach
// perf-tempo-under-modulation.spec.ts uses for pointer drags.
//
// ⚠ It used to be its OWN test, paying a second bootVideoPatch (toybox +
// backdraft + videoOut on SwiftShader) plus 4 s of sampling for three sanity
// asserts, one of which — `blastFps > 0` — a renderer crawling at 0.5 fps
// satisfies, i.e. the exact degenerate state it existed to detect. #1861 folded
// all three into the coalescing test below, where a REAL burst is already
// running: the idle window that was already there supplies the idle arm (and
// doubles as the frame counter's positive control), `burst()` accumulates
// frames across each blast IN THE PAGE, and the wedge check is expressed in
// FRAMES rather than a rate so a slower machine cannot launder it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const ROT_MIN = -3.14159;
const ROT_MAX = 3.14159;

/** midi-learn's linear CC→param mapping (ccValueToParamValue). */
function ccToParam(cc: number, min: number, max: number): number {
  return min + (Math.max(0, Math.min(127, cc)) / 127) * (max - min);
}

type W = {
  __patch: {
    nodes: Record<
      string,
      {
        id: string;
        type: string;
        domain: string;
        params: Record<string, number>;
        data?: { layers?: Array<{ material?: Record<string, number> }> };
      } | undefined
    >;
  };
  __ydoc: {
    on: (ev: string, cb: () => void) => void;
    off: (ev: string, cb: () => void) => void;
  };
  __engine?: () => {
    read: (n: unknown, key: string) => unknown;
    getDomain: (d: string) => { currentFrameCount: () => number };
  } | null;
  __midiTestInstall?: () => boolean;
  __midiTestInject?: (ch: number, cc: number, v: number) => boolean;
  __midiLearnApi?: { importBindings: (b: unknown[]) => void };
  /** Canvas dev probe (identity-reuse gate): current flowNodes/flowEdges +
   *  the xyflow internal-node lookup. */
  __flowGraphProbe?: () => {
    nodes: Array<{ id: string; measured?: unknown }>;
    edges: Array<{ id: string }>;
    internal: (id: string) =>
      | {
          measured?: { width?: number; height?: number };
          internals?: { handleBounds?: unknown; userNode?: unknown };
        }
      | undefined;
  };
};

async function bootVideoPatch(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  // Isolate from any persisted bindings on this dev origin.
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));

  // The owner-report shape: TOYBOX → BACKDRAFT → OUTPUT (birds1's video chain).
  await spawnPatch(
    page,
    [
      { id: 'tb', type: 'toybox', position: { x: 60, y: 60 }, domain: 'video' },
      { id: 'bd', type: 'backdraft', position: { x: 560, y: 60 }, domain: 'video', params: { mix: 0.5, feedback: 0.9 } },
      { id: 'v-out', type: 'videoOut', position: { x: 1060, y: 60 }, domain: 'video' },
    ],
    [
      { id: 'e-tb-bd', from: { nodeId: 'tb', portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a' }, sourceType: 'video', targetType: 'video' },
      { id: 'e-bd-out', from: { nodeId: 'bd', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
    { mountTimeout: 20_000 }, // toybox + backdraft first-paint is slow on SwiftShader
  );

  // Author toybox LAYER 1 (index 0, the default active layer) as an OBJ layer
  // via the DOCK console so the ROT X dial MOUNTS — mounting registers the
  // real midi-learn setter under `tb:layer:0:rotX` (the layer-qualified
  // paramId the console emits). This is the exact seam the owner's Electra
  // binding drives; on the default shell the console lives in the dock body.
  await page.evaluate(() => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('tb'));
  const tbPane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="tb"]');
  await expect(tbPane).toBeVisible();
  await tbPane.locator('[data-testid="toybox-kind-select"]').selectOption('obj');
  await expect(tbPane.locator('[data-testid="toybox-dial-layer:0:rotX"]')).toBeVisible();

  // Sim MIDI device + bindings through the REAL import path (identical
  // dispatch to a learned binding: handleCc → setters.get(key) → the
  // card-mounted onchange).
  await page.waitForFunction(() => typeof (globalThis as unknown as W).__midiTestInstall === 'function');
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__midiTestInstall!();
    w.__midiLearnApi!.importBindings([
      { kind: 'cc', key: 'tb:layer:0:rotX', channel: 0, cc: 21, learnedAt: Date.now() },
      { kind: 'cc', key: 'bd:mix', channel: 0, cc: 22, learnedAt: Date.now() },
    ]);
  });
}

/** Pre-blast liveness check (poly-modules lesson: prove the chain is REAL
 *  before asserting on a storm that could silently no-op). */
async function assertChainLive(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as W).__midiTestInject!(0, 22, 64));
  await expect
    .poll(async () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['bd']?.params['mix']), {
      message: 'single CC lands on backdraft mix (chain live)',
      timeout: 20_000, // settle flush on a starved SwiftShader shard can lag well past the 5s default
    })
    .toBeCloseTo(ccToParam(64, 0, 1), 2);

  await page.evaluate(() => (globalThis as unknown as W).__midiTestInject!(0, 21, 96));
  await expect
    .poll(
      async () =>
        page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tb']?.data?.layers?.[0]?.material?.rotX),
      { message: 'single CC lands on toybox layer:0:rotX (chain live)', timeout: 20_000 },
    )
    .toBeCloseTo(ccToParam(96, ROT_MIN, ROT_MAX), 2);
}

interface BurstResult {
  sent: number;
  txns: number;
  streamMs: number;
  lastVal: number;
  /** VideoEngine frames rendered across the burst window (see burst()). */
  frames: number;
  /** Frames per second across the burst — the log-only FPS diagnostic. */
  fps: number;
}

/** Blast `count` sine-swept CC messages at ~250 msg/s IN-PAGE (one evaluate —
 *  a per-message round-trip caps near ~100 Hz), counting Y.Doc transactions
 *  from the first message until well past the settle flush.
 *
 *  PACING: a schedule-driven catch-up loop, NOT `setTimeout(4)` per message —
 *  on this video-heavy patch the main thread runs long rAF frames, so a
 *  per-message 4 ms sleep stretches the "burst" to many seconds. The catch-up
 *  loop sends however many messages are DUE by wall-clock each turn, exactly
 *  like queued Web MIDI macrotasks draining back-to-back after a stall — so
 *  the wire rate stays ~250 msg/s regardless of render load.
 *
 *  ALSO samples the VideoEngine frame counter across the SAME window (#1861,
 *  absorbing the deleted FPS case): the whole point of the coalescing fix was
 *  that a CC storm must not starve the render loop, and this is the only place
 *  in the file where a real storm is running. Both quantities are accumulated
 *  IN THE PAGE — a Playwright-side poll would be one round trip per sample on
 *  the same main thread as the subject it claims to measure, which on a loaded
 *  runner starves both and makes "frozen" and "never looked" identical from the
 *  output. */
async function burst(page: Page, cc: number, count: number): Promise<BurstResult> {
  return page.evaluate(
    async ({ cc, count }) => {
      const w = globalThis as unknown as W;
      let txns = 0;
      const onU = () => { txns++; };
      w.__ydoc.on('update', onU);
      const video = w.__engine?.()?.getDomain('video');
      const f0 = video ? video.currentFrameCount() : 0;
      const RATE_PER_MS = 0.25; // 250 msg/s
      const t0 = performance.now();
      let sent = 0;
      let lastVal = 0;
      while (sent < count) {
        const due = Math.min(count, Math.floor((performance.now() - t0) * RATE_PER_MS) + 1);
        while (sent < due) {
          // Sine sweep so EVERY message changes the value (no dedupe escape).
          lastVal = Math.round(63.5 + 63.5 * Math.sin(sent * 0.11));
          w.__midiTestInject!(0, cc, lastVal);
          sent++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      const streamMs = performance.now() - t0;
      const frames = video ? video.currentFrameCount() - f0 : -1;
      // Wait out the trailing settle flush (200 ms) + margin.
      await new Promise((r) => setTimeout(r, 700));
      w.__ydoc.off('update', onU);
      return { sent, txns, streamMs, lastVal, frames, fps: (frames / streamMs) * 1000 };
    },
    { cc, count },
  );
}

/** The mechanism-derived transaction ceiling for one burst: a leading-edge
 *  commit + at most one commit per 150 ms throttle window across the MEASURED
 *  stream duration + the settle flush. Deriving from streamMs keeps the bound
 *  exact under CI scheduler jitter (a slower loop legitimately opens more
 *  windows) while staying ~15–20× below the un-coalesced 1-per-message rate. */
function txnCeiling(streamMs: number): number {
  return 2 + Math.ceil(streamMs / 150);
}

test.describe('MIDI-CC coalescing — store-write starvation gate', () => {
  test('a 250 msg/s CC burst coalesces to a handful of Y.Doc transactions + converges on the final value', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    await bootVideoPatch(page, errors);
    await assertChainLive(page);

    // Idle floor: nothing else in this patch writes the doc at rest, so every
    // transaction measured during a burst is attributable to CC dispatch.
    //
    // The same window doubles as the IDLE arm of the FPS diagnostic (#1861) —
    // free, because it is a window this test already had to sit through. It is
    // also the POSITIVE CONTROL for the frame counter: a renderer that reads
    // zero frames at REST is not evidence about CC starvation, it is a broken
    // instrument, and without this leg the under-load reading below could not
    // tell those apart.
    const idle = await page.evaluate(async () => {
      const w = globalThis as unknown as W;
      let txns = 0;
      const onU = () => { txns++; };
      w.__ydoc.on('update', onU);
      const video = w.__engine?.()?.getDomain('video');
      const f0 = video ? video.currentFrameCount() : 0;
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 600));
      const dt = performance.now() - t0;
      const frames = video ? video.currentFrameCount() - f0 : -1;
      w.__ydoc.off('update', onU);
      return { txns, frames, fps: (frames / dt) * 1000 };
    });
    expect(idle.txns, 'idle patch writes no doc transactions').toBe(0);
    expect(
      idle.frames,
      `INSTRUMENT CONTROL: the video engine rendered ${idle.frames} frames in an IDLE 600 ms window `
      + '— the frame counter is unreadable or the render loop is already dead, so the under-load '
      + 'readings below would prove nothing about CC starvation',
    ).toBeGreaterThan(0);

    // ── Leg 1: params-backed module (BACKDRAFT mix — Fader setter path). ──
    const mix = await burst(page, 22, 100);
    console.log(`[perf-midi-cc] backdraft mix burst: sent=${mix.sent} txns=${mix.txns} streamMs=${Math.round(mix.streamMs)} ceiling=${txnCeiling(mix.streamMs)}`);
    console.log(
      `[perf-midi-cc] FPS diagnostic (mix burst): idle=${idle.fps.toFixed(1)} blast=${mix.fps.toFixed(1)} `
      + `ratio=${(idle.fps > 0 ? mix.fps / idle.fps : 0).toFixed(2)} (sent=${mix.sent} msgs @~250/s)`,
    );
    expect(mix.sent).toBe(100);
    expect(mix.txns, 'mix burst coalesced (mechanism ceiling)').toBeLessThanOrEqual(txnCeiling(mix.streamMs));
    expect(mix.txns, 'mix burst nowhere near 1-txn-per-message').toBeLessThan(mix.sent * 0.25);
    expect(mix.txns).toBeGreaterThanOrEqual(1);
    // Final-value convergence: the settled store equals the LAST sent CC.
    await expect
      .poll(async () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['bd']?.params['mix']), { timeout: 20_000 })
      .toBeCloseTo(ccToParam(mix.lastVal, 0, 1), 3);

    // ── Leg 2: toybox DATA-write leg (layer:0:rotX — Knob setter → setMat). ──
    const rot = await burst(page, 21, 100);
    console.log(`[perf-midi-cc] toybox rotX burst: sent=${rot.sent} txns=${rot.txns} streamMs=${Math.round(rot.streamMs)} ceiling=${txnCeiling(rot.streamMs)}`);
    console.log(
      `[perf-midi-cc] FPS diagnostic (rotX burst): idle=${idle.fps.toFixed(1)} blast=${rot.fps.toFixed(1)} `
      + `ratio=${(idle.fps > 0 ? rot.fps / idle.fps : 0).toFixed(2)} (sent=${rot.sent} msgs @~250/s)`,
    );
    expect(rot.sent).toBe(100);
    expect(rot.txns, 'rotX burst coalesced (mechanism ceiling)').toBeLessThanOrEqual(txnCeiling(rot.streamMs));
    expect(rot.txns, 'rotX burst nowhere near 1-txn-per-message').toBeLessThan(rot.sent * 0.25);
    const expectedRot = ccToParam(rot.lastVal, ROT_MIN, ROT_MAX);
    // Settled store value (node.data.layers write via setLayerMaterialField).
    await expect
      .poll(
        async () =>
          page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tb']?.data?.layers?.[0]?.material?.rotX),
        { timeout: 20_000 },
      )
      .toBeCloseTo(expectedRot, 3);
    // The ENGINE's render-local clone agrees (transient leg + post-commit
    // re-sync are idempotent — the mustNotBreak reconciler-echo contract).
    const engineRot = await page.evaluate(() => {
      const w = globalThis as unknown as W;
      const node = w.__patch.nodes['tb'];
      const lm = w.__engine?.()?.read(node, 'liveModulated') as
        | { layers?: Array<{ material?: Record<string, number> }> }
        | undefined;
      return lm?.layers?.[0]?.material?.rotX;
    });
    expect(engineRot).toBeCloseTo(expectedRot, 3);

    // ── RENDERING NEVER FULLY WEDGED (#1861) ────────────────────────────────
    // This was a separate test that paid its own bootVideoPatch (toybox +
    // backdraft + videoOut on SwiftShader) plus 4 s of sampling, to assert
    // `blastFps > 0` — which a renderer crawling at 0.5 fps satisfies, i.e. the
    // exact degenerate state it existed to detect. Its window is now this one,
    // where a REAL coalescing burst is running, and its check is expressed as
    // FRAMES rather than a rate so it says something a slower machine cannot
    // launder: across the burst the engine rendered at least one frame.
    //
    // ⚠ It is deliberately still a FLOOR, not a ratio gate. CI's SwiftShader
    // FPS is too noisy for an absolute or relative threshold (repo memory:
    // capability/renderer-dependent e2e), and the STARVATION MECHANISM is
    // pinned deterministically by the transaction ceilings above — this leg
    // only rules out "the render loop stopped entirely", which the ceilings
    // cannot see. The idle arm above is what stops it being vacuous.
    expect(
      mix.frames,
      `render loop wedged during the mix burst: ${mix.frames} frames in ${Math.round(mix.streamMs)} ms `
      + `(idle reference ${idle.fps.toFixed(1)} fps)`,
    ).toBeGreaterThan(0);
    expect(
      rot.frames,
      `render loop wedged during the rotX burst: ${rot.frames} frames in ${Math.round(rot.streamMs)} ms `
      + `(idle reference ${idle.fps.toFixed(1)} fps)`,
    ).toBeGreaterThan(0);

    expect(errors, 'no page errors during the CC storm').toEqual([]);
  });

  test('MULTI-KNOB burst: 4 bound knobs @ ~250 msg/s each coalesce into the SHARED two-lane windows', async ({ page }) => {
    // Phase-2 gate (global CC batcher): #1030 gave each (module,param) pump
    // its own private throttle timer, so N twisted knobs = N independent
    // ~6.7 txn/s streams. The shared batcher drains ALL due pumps into at
    // most ONE transaction per lane per 150ms window — so the TOTAL
    // transaction count for a 4-knob gesture must fit the TWO-LANE ceiling
    // 2*(2 + ceil(streamMs/150)), not 4x the single-knob ceiling (and
    // nowhere near 1-per-message). Deterministic + renderer-proof.
    test.setTimeout(180_000);
    const errors: string[] = [];
    await bootVideoPatch(page, errors);
    // Two more real card-mounted knobs (4 total, all midi-learn → the
    // undoable lane; the two-lane ceiling still allows for the bare lane).
    await page.evaluate(() => {
      const w = globalThis as unknown as W;
      w.__midiLearnApi!.importBindings([
        { kind: 'cc', key: 'tb:layer:0:rotX', channel: 0, cc: 21, learnedAt: Date.now() },
        { kind: 'cc', key: 'bd:mix', channel: 0, cc: 22, learnedAt: Date.now() },
        { kind: 'cc', key: 'bd:feedback', channel: 0, cc: 23, learnedAt: Date.now() },
        { kind: 'cc', key: 'tb:layer:0:rotY', channel: 0, cc: 24, learnedAt: Date.now() },
      ]);
    });
    await assertChainLive(page);

    const res = await page.evaluate(async () => {
      const w = globalThis as unknown as W;
      let txns = 0;
      const onU = () => { txns++; };
      w.__ydoc.on('update', onU);
      const CCS = [21, 22, 23, 24];
      const RATE_PER_MS = 1.0; // 4 knobs x 250 msg/s = 1000 msg/s total
      const STREAM_MS = 1500;
      const t0 = performance.now();
      let sent = 0;
      const lastVal: Record<number, number> = {};
      // Schedule-driven catch-up loop (see burst()): the wire rate holds
      // even when the render loop stalls the main thread.
      const TOTAL = Math.floor(STREAM_MS * RATE_PER_MS) + 1;
      while (performance.now() - t0 < STREAM_MS) {
        const due = Math.min(TOTAL, Math.floor((performance.now() - t0) * RATE_PER_MS) + 1);
        while (sent < due) {
          const cc = CCS[sent % 4]!;
          const val = Math.round(63.5 + 63.5 * Math.sin(sent * 0.11));
          lastVal[cc] = val;
          w.__midiTestInject!(0, cc, val);
          sent++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      // FINAL CATCH-UP: on a starved shard a stall can carry `elapsed` past
      // STREAM_MS and exit the loop before the last due window was pumped,
      // leaving `sent` load-dependent (the shard-9 reshuffle failure). Pump
      // the remainder so `sent` is DETERMINISTIC (= TOTAL) under any load —
      // the ceiling below derives from the ACTUAL streamMs, so the mechanism
      // gate is unaffected.
      while (sent < TOTAL) {
        const cc = CCS[sent % 4]!;
        const val = Math.round(63.5 + 63.5 * Math.sin(sent * 0.11));
        lastVal[cc] = val;
        w.__midiTestInject!(0, cc, val);
        sent++;
      }
      const streamMs = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 700)); // settle + margin
      w.__ydoc.off('update', onU);
      return { sent, txns, streamMs, lastVal };
    });

    const twoLaneCeiling = 2 * (2 + Math.ceil(res.streamMs / 150));
    console.log(
      `[perf-midi-cc] MULTI-KNOB burst: sent=${res.sent} txns=${res.txns} `
      + `streamMs=${Math.round(res.streamMs)} two-lane ceiling=${twoLaneCeiling}`,
    );
    expect(res.sent).toBe(1501); // the storm ran to completion (deterministic — final catch-up)
    expect(res.txns, 'total transactions fit the SHARED two-lane windows').toBeLessThanOrEqual(twoLaneCeiling);
    expect(res.txns, 'nowhere near per-knob-per-window (pre-batcher: ~4x)').toBeLessThan(res.sent * 0.05);
    expect(res.txns).toBeGreaterThanOrEqual(1);

    // Final-value convergence per module + per param (collab/persistence).
    await expect
      .poll(async () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['bd']?.params['mix']), { timeout: 20_000 })
      .toBeCloseTo(ccToParam(res.lastVal[22]!, 0, 1), 3);
    await expect
      .poll(async () =>
        page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tb']?.data?.layers?.[0]?.material?.rotX), { timeout: 20_000 })
      .toBeCloseTo(ccToParam(res.lastVal[21]!, ROT_MIN, ROT_MAX), 3);
    expect(errors, 'no page errors during the multi-knob storm').toEqual([]);
  });

  test('flowNode identity + measured survive a settled CC commit (no per-commit re-measure)', async ({ page }) => {
    // Phase-2 gate (Canvas per-entry reuse): a settled CC commit on ONE
    // module must not rebuild the OTHER cards' FlowNode objects — a fresh
    // object per node per commit is what made xyflow rebuild every
    // InternalNode, reset `measured`, and getBoundingClientRect-re-measure
    // every handle of every card (~6.7×/s during a twist). Deterministic +
    // renderer-independent: pure object-identity asserts, no FPS.
    test.setTimeout(180_000);
    const errors: string[] = [];
    await bootVideoPatch(page, errors);
    await assertChainLive(page);

    const res = await page.evaluate(async () => {
      const w = globalThis as unknown as W;
      const probe = w.__flowGraphProbe!;
      // Warmup commit: after it, the reuse pass has already switched to
      // xyflow's post-measure userNode clones (steady state).
      w.__midiTestInject!(0, 21, 30);
      await new Promise((r) => setTimeout(r, 700));

      const before = probe();
      const findN = (arr: Array<{ id: string }>, id: string) => arr.find((n) => n.id === id);
      const bdBefore = findN(before.nodes, 'bd');
      const outBefore = findN(before.nodes, 'v-out');
      const tbBefore = findN(before.nodes, 'tb');
      const edgeBefore = findN(before.edges, 'e-bd-out');
      const outInternalBefore = before.internal('v-out');
      const outHandleBoundsBefore = outInternalBefore?.internals?.handleBounds;

      // The commit under test: one CC on the TOYBOX knob (leading commit +
      // settle flush land two store transactions on node tb).
      w.__midiTestInject!(0, 21, 90);
      await new Promise((r) => setTimeout(r, 700));

      const after = probe();
      const outInternalAfter = after.internal('v-out');
      return {
        // Untouched cards + cables: reference-identical FlowNode/FlowEdge.
        bdReused: findN(after.nodes, 'bd') === bdBefore,
        outReused: findN(after.nodes, 'v-out') === outBefore,
        edgeReused: findN(after.edges, 'e-bd-out') === edgeBefore,
        // The whole InternalNode survived (adoptUserNodes checkEquality hit
        // → no re-parse, no re-measure): object + handleBounds identity.
        internalReused: outInternalAfter === outInternalBefore,
        handleBoundsReused:
          outInternalAfter?.internals?.handleBounds === outHandleBoundsBefore
          && outHandleBoundsBefore !== undefined,
        // checkEquality's actual predicate: our array entry IS xyflow's
        // internals.userNode.
        userNodeHit: outInternalAfter?.internals?.userNode === findN(after.nodes, 'v-out'),
        // The DIRTY node rebuilds (fresh entry carrying the new snapshot)…
        tbRebuilt: findN(after.nodes, 'tb') !== tbBefore,
        // …but carries `measured` forward, so even IT does not re-measure.
        tbMeasuredKept: after.internal('tb')?.measured?.width !== undefined,
      };
    });

    expect(res.bdReused, 'untouched BACKDRAFT FlowNode reused').toBe(true);
    expect(res.outReused, 'untouched OUTPUT FlowNode reused').toBe(true);
    expect(res.edgeReused, 'untouched FlowEdge reused').toBe(true);
    expect(res.internalReused, 'xyflow InternalNode reused (no adopt rebuild)').toBe(true);
    expect(res.handleBoundsReused, 'handleBounds survive (no handle re-measure)').toBe(true);
    expect(res.userNodeHit, 'checkEquality seam hits (entry === internals.userNode)').toBe(true);
    expect(res.tbRebuilt, 'dirty TOYBOX entry rebuilds').toBe(true);
    expect(res.tbMeasuredKept, 'dirty node keeps measured (no re-measure)').toBe(true);
    expect(errors, 'no page errors').toEqual([]);
  });
});
