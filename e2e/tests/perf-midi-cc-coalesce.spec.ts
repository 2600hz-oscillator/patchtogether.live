// e2e/tests/perf-midi-cc-coalesce.spec.ts
//
// Regression gate for the MIDI-CC → video-render starvation fix (the owner's
// "twisting Electra knobs murders video rendering" report, birds1 patch).
//
// MECHANISM (verified in .myrobots/plans/midi-cc-perf-fix-2026-07-05.md):
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
// The FPS measurement is deliberately a LOG-ONLY diagnostic (second test):
// CI's SwiftShader software renderer makes absolute-FPS asserts flaky (repo
// memory: capability/renderer-dependent e2e), while the transaction-count
// invariant above pins the starvation mechanism deterministically — the same
// approach perf-tempo-under-modulation.spec.ts uses for pointer drags.

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
};

async function bootVideoPatch(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack');
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
  // via the card UI so the ROT X knob MOUNTS — mounting registers the real
  // midi-learn setter under `tb:layer:0:rotX` (the layer-qualified paramId
  // ToyboxCard passes). This is the exact seam the owner's Electra binding
  // drives.
  await page.locator('[data-testid="toybox-kind-select"]').selectOption('obj');
  await expect(page.locator('[role="slider"][aria-label="ROT X"]')).toBeVisible();

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
    })
    .toBeCloseTo(ccToParam(64, 0, 1), 2);

  await page.evaluate(() => (globalThis as unknown as W).__midiTestInject!(0, 21, 96));
  await expect
    .poll(
      async () =>
        page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tb']?.data?.layers?.[0]?.material?.rotX),
      { message: 'single CC lands on toybox layer:0:rotX (chain live)' },
    )
    .toBeCloseTo(ccToParam(96, ROT_MIN, ROT_MAX), 2);
}

interface BurstResult {
  sent: number;
  txns: number;
  streamMs: number;
  lastVal: number;
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
 *  the wire rate stays ~250 msg/s regardless of render load. */
async function burst(page: Page, cc: number, count: number): Promise<BurstResult> {
  return page.evaluate(
    async ({ cc, count }) => {
      const w = globalThis as unknown as W;
      let txns = 0;
      const onU = () => { txns++; };
      w.__ydoc.on('update', onU);
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
      // Wait out the trailing settle flush (200 ms) + margin.
      await new Promise((r) => setTimeout(r, 700));
      w.__ydoc.off('update', onU);
      return { sent, txns, streamMs, lastVal };
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
    const idle = await page.evaluate(async () => {
      const w = globalThis as unknown as W;
      let txns = 0;
      const onU = () => { txns++; };
      w.__ydoc.on('update', onU);
      await new Promise((r) => setTimeout(r, 600));
      w.__ydoc.off('update', onU);
      return txns;
    });
    expect(idle, 'idle patch writes no doc transactions').toBe(0);

    // ── Leg 1: params-backed module (BACKDRAFT mix — Fader setter path). ──
    const mix = await burst(page, 22, 100);
    console.log(`[perf-midi-cc] backdraft mix burst: sent=${mix.sent} txns=${mix.txns} streamMs=${Math.round(mix.streamMs)} ceiling=${txnCeiling(mix.streamMs)}`);
    expect(mix.sent).toBe(100);
    expect(mix.txns, 'mix burst coalesced (mechanism ceiling)').toBeLessThanOrEqual(txnCeiling(mix.streamMs));
    expect(mix.txns, 'mix burst nowhere near 1-txn-per-message').toBeLessThan(mix.sent * 0.25);
    expect(mix.txns).toBeGreaterThanOrEqual(1);
    // Final-value convergence: the settled store equals the LAST sent CC.
    await expect
      .poll(async () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['bd']?.params['mix']))
      .toBeCloseTo(ccToParam(mix.lastVal, 0, 1), 3);

    // ── Leg 2: toybox DATA-write leg (layer:0:rotX — Knob setter → setMat). ──
    const rot = await burst(page, 21, 100);
    console.log(`[perf-midi-cc] toybox rotX burst: sent=${rot.sent} txns=${rot.txns} streamMs=${Math.round(rot.streamMs)} ceiling=${txnCeiling(rot.streamMs)}`);
    expect(rot.sent).toBe(100);
    expect(rot.txns, 'rotX burst coalesced (mechanism ceiling)').toBeLessThanOrEqual(txnCeiling(rot.streamMs));
    expect(rot.txns, 'rotX burst nowhere near 1-txn-per-message').toBeLessThan(rot.sent * 0.25);
    const expectedRot = ccToParam(rot.lastVal, ROT_MIN, ROT_MAX);
    // Settled store value (node.data.layers write via setLayerMaterialField).
    await expect
      .poll(
        async () =>
          page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tb']?.data?.layers?.[0]?.material?.rotX),
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

    expect(errors, 'no page errors during the CC storm').toEqual([]);
  });

  test('FPS under CC blast — LOG-ONLY diagnostic (renderer-dependent, not a CI gate)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    await bootVideoPatch(page, errors);
    await assertChainLive(page);

    const result = await page.evaluate(async () => {
      const w = globalThis as unknown as W;
      const video = w.__engine!()!.getDomain('video');
      const sample = async (ms: number): Promise<number> => {
        const f0 = video.currentFrameCount();
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        const dt = performance.now() - t0;
        return ((video.currentFrameCount() - f0) / dt) * 1000;
      };

      const idleFps = await sample(2000);

      // Sustained alternating blast at ~250 msg/s for 2 s while sampling —
      // schedule-driven catch-up pacing (see burst() above) so the wire rate
      // holds even when the render loop stalls the main thread.
      let stop = false;
      const blaster = (async () => {
        const RATE_PER_MS = 0.25;
        const b0 = performance.now();
        let i = 0;
        while (!stop) {
          const due = Math.floor((performance.now() - b0) * RATE_PER_MS) + 1;
          while (i < due) {
            const val = Math.round(63.5 + 63.5 * Math.sin(i * 0.11));
            w.__midiTestInject!(0, i % 2 === 0 ? 21 : 22, val);
            i++;
          }
          await new Promise((r) => setTimeout(r, 0));
        }
        return i;
      })();
      const blastFps = await sample(2000);
      stop = true;
      const sent = await blaster;

      return { idleFps, blastFps, sent, ratio: idleFps > 0 ? blastFps / idleFps : 0 };
    });

    // Deliverable diagnostic line (owner go/no-go; CI-visible in the report).
    console.log(
      `[perf-midi-cc] FPS diagnostic: idle=${result.idleFps.toFixed(1)} blast=${result.blastFps.toFixed(1)} ` +
      `ratio=${result.ratio.toFixed(2)} (sent=${result.sent} msgs @~250/s)`,
    );

    // Only sanity-level asserts (SwiftShader FPS is too noisy for a ratio
    // gate): the storm actually ran, and rendering never fully wedged.
    expect(result.sent).toBeGreaterThan(200);
    expect(result.blastFps).toBeGreaterThan(0);
    expect(errors, 'no page errors during the FPS diagnostic').toEqual([]);
  });
});
