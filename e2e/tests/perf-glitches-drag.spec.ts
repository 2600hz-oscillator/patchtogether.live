// e2e/tests/perf-glitches-drag.spec.ts
//
// MEASUREMENT (timing-architecture review, "measure the real symptoms first"):
// the user's EXACT worst-case action — "pick up a module and drag it around"
// WHILE the video-heavy 'glitches get riches' demo is running. The three prior
// measurements isolated each factor and found the clock healthy:
//   - perf-midi-cc-burst : uncoalesced Yjs write storm        → clock fine
//   - perf-node-drag     : cabled node drag on a LIGHT patch  → clock fine
//   - perf-glitches-idle : heavy-video demo idle              → ~21fps video lag,
//                                                                but clock fine (0 drops)
// This is the COMBINATION: heavy-video main-thread load (~47ms frames) PLUS a
// SvelteFlow node-drag on top. If anything tips the main-thread clock over, it's
// here. We load the real glitches demo, drag a node with the real mouse for ~2s,
// and sample the internally-clocked stepper's lateStepsDropped/pastDueEmits +
// long-tasks + frame intervals during the drag.
//
// VERDICT: lateStepsDropped climbing here (but not in the isolated tests) pins
// the failure to MAIN-THREAD SATURATION (video render + drag render competing
// with the clock tick) — the fix is render-cost reduction and/or moving the
// steppers' clocks to the audio thread (worklet), NOT the Yjs/sync architecture.
// The console.log is the deliverable.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const DRAG_MS = 2500;

test('perf-glitches-drag: node drag during the heavy-video demo (the real worst case)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.selectOption('[data-testid="load-example-select"]', 'glitches');
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return !!w.__patch && Object.keys(w.__patch.nodes).length >= 20;
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1500);

  // Install long-task observer + record the clock baseline.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __gdrag?: { ms: number; n: number; po?: PerformanceObserver; clock?: { id: string; type: string; domain: string } | null; late0: number; pd0: number; adv0: number; t0: number };
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
    };
    let clock: { id: string; type: string; domain: string } | null = null;
    for (const n of Object.values(w.__patch.nodes)) {
      if (n && (n.type === 'drumseqz' || n.type === 'macseq' || n.type === 'sequencer')) { clock = n; break; }
    }
    const eng = w.__engine?.();
    const rd = (k: string) => { if (!eng || !clock) return -1; const v = eng.read(clock, k); return typeof v === 'number' ? v : -1; };
    w.__gdrag = { ms: 0, n: 0, clock, late0: rd('lateStepsDropped'), pd0: rd('pastDueEmits'), adv0: rd('totalAdvances'), t0: performance.now() };
    try {
      const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { w.__gdrag!.ms += e.duration; w.__gdrag!.n++; } });
      po.observe({ entryTypes: ['longtask'] });
      w.__gdrag.po = po;
    } catch { /* unsupported */ }
  });

  // Drag the first on-screen node with the real mouse.
  const node = page.locator('.svelte-flow__node').first();
  const box = await node.boundingBox();
  if (!box) throw new Error('no draggable node found in glitches');
  const cx = box.x + box.width / 2;
  const cy = box.y + 10;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < DRAG_MS) {
    const dx = 70 * Math.sin(k * 0.35);
    const dy = 45 * Math.cos(k * 0.5);
    await page.mouse.move(cx + dx, cy + dy, { steps: 2 });
    k++;
  }
  await page.mouse.up();

  const r = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __gdrag: { ms: number; n: number; po?: PerformanceObserver; clock?: { id: string; type: string; domain: string } | null; late0: number; pd0: number; adv0: number; t0: number };
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
    };
    w.__gdrag.po?.disconnect();
    const eng = w.__engine?.();
    const c = w.__gdrag.clock;
    const rd = (k: string) => { if (!eng || !c) return -1; const v = eng.read(c, k); return typeof v === 'number' ? v : -1; };
    return {
      clockType: c?.type ?? 'none',
      lateDelta: rd('lateStepsDropped') - w.__gdrag.late0,
      pdDelta: rd('pastDueEmits') - w.__gdrag.pd0,
      advDelta: rd('totalAdvances') - w.__gdrag.adv0,
      windowMs: performance.now() - w.__gdrag.t0,
      longMs: w.__gdrag.ms, longN: w.__gdrag.n,
    };
  });

  // eslint-disable-next-line no-console
  console.log(
    `[perf-glitches-drag] clock=${r.clockType} mouseMoves=${k} window=${r.windowMs.toFixed(0)}ms | ` +
      `CLOCK: lateStepsDropped+=${r.lateDelta} pastDueEmits+=${r.pdDelta} advances=${r.advDelta} | ` +
      `longTasks=${r.longN} totalLongTaskMs=${r.longMs.toFixed(0)} (${((r.longMs / r.windowMs) * 100).toFixed(0)}% of window)`,
  );

  // A LOW move count is itself a finding: under the heavy-video main-thread load
  // the real mouse can barely advance (the UI is the lag). Just confirm the drag
  // engaged at all.
  expect(k, 'drag did not engage at all').toBeGreaterThan(2);
  // Measurement: surface whether the COMBINED load starves the clock. pastDue
  // (bunching) must never happen; lateStepsDropped is the graceful-degrade signal.
  expect(r.pdDelta, 'pastDueEmits climbed — clock bunched onto "now" under glitches+drag').toBe(0);
});
