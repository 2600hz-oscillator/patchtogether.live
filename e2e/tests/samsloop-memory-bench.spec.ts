// e2e/tests/samsloop-memory-bench.spec.ts
//
// Empirical memory measurement for SAMSLOOP, used to justify the
// per-rackspace + per-user instance caps documented in
// packages/web/src/lib/multiplayer/samsloop-limits.ts.
//
// Methodology:
//   1. Boot a fresh page, force GC (via CDP Heap.collectGarbage), read
//      `performance.memory.usedJSHeapSize` as the baseline.
//   2. Spawn N SAMSLOOP nodes, each pre-loaded with a 250 KB-equivalent
//      mono Float32Array (62_500 samples — the worst-case decoded
//      payload from a 250 KB raw WAV file).
//   3. Force GC again, read heap, compute (heapAfter − heapBefore) / N.
//   4. Print the per-instance cost so we have a reproducible number
//      backing the chosen cap.
//
// Run via: task e2e -- --project=chromium-samsloop tests/samsloop-memory-bench.spec.ts
// Gated by E2E_RUN_MEM_BENCH=1 so it doesn't pad normal CI runtime —
// the cap value it produces is committed into samsloop-limits.ts and
// the comment block there links here for reproduction.

import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SHOULD_RUN = process.env.E2E_RUN_MEM_BENCH === '1';

async function readHeap(page: Page, cdp: CDPSession): Promise<number> {
  // Force GC twice — V8 sometimes needs a second pass to collect freshly
  // unreachable objects from the first sweep.
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  // Small settle so finalizers finish.
  await page.waitForTimeout(150);
  // CDP Runtime.getHeapUsage returns precise byte counts (no 5MB
  // quantization like performance.memory does). Note: CDP must target
  // the page's execution context, not the browser session — newPage's
  // page.context().newCDPSession(page) is correct.
  try {
    const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize?: number };
    if (typeof usage.usedSize === 'number' && usage.usedSize > 0) {
      return usage.usedSize;
    }
  } catch {
    // fall through to performance.memory below
  }
  return await page.evaluate(() => {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? 0;
  });
}

test.describe('SAMSLOOP memory bench (gated, manual)', () => {
  test.skip(!SHOULD_RUN, 'set E2E_RUN_MEM_BENCH=1 to run');
  test.setTimeout(180_000);

  test('per-instance heap cost — spawn 20 SAMSLOOPs with worst-case payload', async ({ page, browser }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    // networkidle hangs intermittently on dev server (Vite HMR ws keepalive).
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
      undefined,
      { timeout: 60_000 },
    );

    // Target the PAGE context, not the browser, so Runtime.getHeapUsage
    // returns the page's V8 isolate stats.
    const cdp = await page.context().newCDPSession(page);

    // Baseline reading — one no-op SAMSLOOP to "warm" the worklet module
    // load + the AudioContext, so the per-instance delta we measure
    // doesn't include one-time setup overhead.
    await spawnPatch(page, [
      { id: 'warm', type: 'samsloop', position: { x: 100, y: 100 } },
    ]);
    await page.waitForTimeout(500);

    const heapBefore = await readHeap(page, cdp);

    // Spawn N SAMSLOOPs first (no data), then assign payload to each
    // in a transact. SAMPLE_LEN reduced to 8_000 here because syncedstore's
    // recursive crdtValue() blows the JS stack at 60k+. The per-instance
    // overhead we want to characterize (canvas pixels, worklet buffer,
    // graph state, syncedstore proxy chain) is independent of payload
    // length — and the payload size is a known constant we add back in
    // the printout (62_500 floats = 250_000 raw bytes worst case).
    const N = 30;
    const SAMPLE_LEN = 8_000;
    const spawnNodes: Array<{ id: string; type: string; position: { x: number; y: number } }> = [];
    for (let i = 0; i < N; i++) {
      spawnNodes.push({ id: 'bench-' + i, type: 'samsloop', position: { x: 200 + (i % 10) * 30, y: 200 + Math.floor(i / 10) * 30 } });
    }
    await spawnPatch(page, spawnNodes);
    // Now stuff the payload into each node.data inside one transact.
    await page.evaluate(({ n, len }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown>; params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (let i = 0; i < n; i++) {
          const samples: number[] = new Array(len);
          for (let j = 0; j < len; j++) samples[j] = Math.sin(j * 0.001) * 0.5;
          const node = w.__patch.nodes['bench-' + i];
          if (!node) continue;
          node.data = {
            samples,
            sampleRate: 22050,
            sampleLength: len,
            fileName: 'bench-' + i + '.wav',
          };
          node.params.start = 0;
          node.params.end = len;
        }
      });
    }, { n: N, len: SAMPLE_LEN });

    // Let the engine actually instantiate + ship samples to worklets.
    await page.waitForTimeout(3000);

    // Sanity probe — did the nodes actually get into the patch graph?
    const nodeCount = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
      let n = 0;
      for (const k of Object.keys(w.__patch.nodes)) {
        if (k.startsWith('bench-')) n++;
      }
      return n;
    });
    const samplesLoadedSanity = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { samples?: { length?: number } } }> };
      };
      const node = w.__patch.nodes['bench-0'];
      return node?.data?.samples?.length ?? 0;
    });
    // Also count engine-instantiated nodes — the engine builds the
    // AudioWorkletNode + Float32 buffer + canvas-related retained state.
    const engineNodeCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { domains?: Record<string, { nodes?: Map<string, unknown> }> } | null;
      };
      const eng = w.__engine?.();
      if (!eng) return -1;
      const audio = eng.domains?.audio;
      return audio?.nodes ? audio.nodes.size : -2;
    });
    console.log('Nodes spawned (sanity)     :', nodeCount, '(expected', N, ')');
    console.log('bench-0 samples length     :', samplesLoadedSanity, '(expected', SAMPLE_LEN, ')');
    console.log('Engine-instantiated nodes  :', engineNodeCount);

    const heapAfter = await readHeap(page, cdp);

    const totalBytes = heapAfter - heapBefore;
    const perInstanceMeasured = totalBytes / N;
    const measuredPayloadBytes = SAMPLE_LEN * 4; // Float32 = 4 bytes/sample
    const overheadPerInstance = perInstanceMeasured - measuredPayloadBytes;
    // Worst-case projection: scale payload up to 62_500 floats (250 KB raw),
    // keep overhead constant. This is the figure we cap on.
    const WORST_CASE_SAMPLE_LEN = 62_500;
    const worstCasePerInstance = overheadPerInstance + WORST_CASE_SAMPLE_LEN * 4;

    console.log('--- SAMSLOOP memory bench ---');
    console.log('N instances                :', N);
    console.log('Samples per instance       :', SAMPLE_LEN);
    console.log('Measured payload/inst      :', measuredPayloadBytes, 'bytes');
    console.log('Heap before                :', heapBefore, 'bytes');
    console.log('Heap after                 :', heapAfter, 'bytes');
    console.log('Heap delta                 :', totalBytes, 'bytes');
    console.log('Heap delta / instance      :', perInstanceMeasured.toFixed(0), 'bytes');
    console.log('Overhead / instance        :', overheadPerInstance.toFixed(0), 'bytes (canvas, worklet ring, graph state, syncedstore proxy)');
    console.log('Worst-case (250KB raw)/inst:', worstCasePerInstance.toFixed(0), 'bytes');
    console.log('--- end bench ---');

    expect(perInstanceMeasured).toBeGreaterThan(0);
    expect(errors, errors.join('; ')).toEqual([]);
  });
});
