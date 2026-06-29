// e2e/tests/perf-glitches-idle.spec.ts
//
// MEASUREMENT (timing-architecture review, "measure the real symptoms first"):
// the "slowdowns and drags JUST loading 'glitches get riches', not interacting
// at all" report. The two prior measurements (perf-midi-cc-burst, perf-node-drag)
// showed the CLOCK is unperturbed by the Yjs write-storm and by a cabled
// node-drag at moderate scale — so the suspect for the glitches lag is the patch
// itself: it's VIDEO-HEAVY (5× videoOut + ruttetra + feedback + destructor +
// colorizer + buggles + monoglitch + picturebox + videoMixer), all rendering
// WebGL every animation frame on the main/compositor thread.
//
// This loads the ACTUAL glitches demo (the topbar "Load example…" → Glitches
// Get Riches path, i.e. loadEnvelopeIntoStore of the real 27-node envelope) and,
// WITHOUT any interaction, measures over a 3s idle window:
//   - rAF frame intervals (avg / p95 / count over 20ms / over 33ms) = the "lag"
//   - total main-thread long-task time (PerformanceObserver)
//   - the internally-clocked stepper's lateStepsDropped (drumseqz/macseq) = does
//     the video render starve the clock with ZERO interaction?
//
// VERDICT: if frames are janky (high p95 / many >33ms) and/or long-tasks pile up
// while the clock counters climb, the "laggy + tempo" symptom is the VIDEO
// PIPELINE saturating the shared main thread — NOT the clock architecture, and
// NOT fixable by a/b/c. The console.log is the deliverable.
//
// NOTE: runs against the LOCAL real GPU; on CI's SwiftShader the absolute numbers
// differ, so the hard assertions stay loose — this spec is a measurement first.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const IDLE_MS = 3000;

test('perf-glitches-idle: heavy-video demo idle frame-jank + clock health', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Load the real "Glitches Get Riches" demo via the topbar action menu.
  await page.selectOption('[data-testid="load-example-select"]', 'glitches');

  // Wait for the heavy patch to materialize (its ~27 nodes land in the store).
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return !!w.__patch && Object.keys(w.__patch.nodes).length >= 20;
    },
    undefined,
    { timeout: 20_000 },
  );
  // Let the video pipeline + clocks spin up.
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async (durationMs) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
    };

    // Find an internally-clocked stepper to read clock health from.
    let clockNode: { id: string; type: string; domain: string } | null = null;
    for (const n of Object.values(w.__patch.nodes)) {
      if (n && (n.type === 'drumseqz' || n.type === 'macseq' || n.type === 'sequencer')) { clockNode = n; break; }
    }
    const eng = w.__engine?.();
    const readClock = (k: string): number => {
      if (!eng || !clockNode) return -1;
      const v = eng.read(clockNode, k);
      return typeof v === 'number' ? v : -1;
    };

    // Long-task observer.
    let longMs = 0, longN = 0;
    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longMs += e.duration; longN++; } });
      po.observe({ entryTypes: ['longtask'] });
    } catch { /* unsupported */ }

    const lateBefore = readClock('lateStepsDropped');
    const advBefore = readClock('totalAdvances');

    // Sample rAF frame intervals across the idle window.
    const frames: number[] = [];
    const start = performance.now();
    let last = start;
    await new Promise<void>((resolve) => {
      const onFrame = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (now - start < durationMs) requestAnimationFrame(onFrame);
        else resolve();
      };
      requestAnimationFrame(onFrame);
    });
    const windowMs = performance.now() - start;
    po?.disconnect();

    const lateAfter = readClock('lateStepsDropped');
    const advAfter = readClock('totalAdvances');

    frames.sort((a, b) => a - b);
    const sum = frames.reduce((s, x) => s + x, 0);
    const avg = sum / Math.max(1, frames.length);
    const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
    const worst = frames[frames.length - 1] ?? 0;
    const over20 = frames.filter((f) => f > 20).length;
    const over33 = frames.filter((f) => f > 33).length;

    return {
      clockType: clockNode?.type ?? 'none',
      nodeCount: Object.keys(w.__patch.nodes).length,
      frames: frames.length, windowMs, avg, p95, worst, over20, over33,
      longMs, longN,
      lateDelta: lateAfter >= 0 && lateBefore >= 0 ? lateAfter - lateBefore : -1,
      advDelta: advAfter >= 0 && advBefore >= 0 ? advAfter - advBefore : -1,
    };
  }, IDLE_MS);

  const fps = (result.frames / result.windowMs) * 1000;
  // eslint-disable-next-line no-console
  console.log(
    `[perf-glitches-idle] nodes=${result.nodeCount} clock=${result.clockType} ` +
      `window=${result.windowMs.toFixed(0)}ms | FRAMES: ${result.frames} (~${fps.toFixed(0)}fps) ` +
      `avg=${result.avg.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms worst=${result.worst.toFixed(0)}ms ` +
      `over20ms=${result.over20} over33ms=${result.over33} | ` +
      `longTasks=${result.longN} totalLongTaskMs=${result.longMs.toFixed(0)} ` +
      `(${((result.longMs / result.windowMs) * 100).toFixed(0)}%) | ` +
      `CLOCK(${result.clockType}): lateStepsDropped+=${result.lateDelta} advances=${result.advDelta}`,
  );

  // The demo actually loaded.
  expect(result.nodeCount).toBeGreaterThanOrEqual(20);
  // This is a measurement; the log is the deliverable. We only assert the run
  // produced frames (no hard jank threshold — local GPU vs CI SwiftShader differ).
  expect(result.frames).toBeGreaterThan(10);
});
