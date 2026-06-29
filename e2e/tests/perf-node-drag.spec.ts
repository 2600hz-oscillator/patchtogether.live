// e2e/tests/perf-node-drag.spec.ts
//
// MEASUREMENT (timing-architecture review, "measure the real symptoms first"):
// the "dragging a module around makes the tempo unstable" report. Unlike
// perf-midi-cc-burst (which tested the Yjs WRITE storm and found the clock
// unaffected), this tests the OTHER contention source: SvelteFlow's per-frame
// node-drag re-render (edge-path recompute for every cable on the dragged node +
// scene repaint), which runs on the SAME main thread as the clock's tick().
//
// We drag a HEAVILY-CABLED running sequencer (its clock-out / gate fan out to
// many sinks, so dragging it forces SvelteFlow to recompute many edge paths per
// frame) with the REAL Playwright mouse for ~2s, and sample the sequencer's own
// clock-health counters (lateStepsDropped / pastDueEmits — exposed via
// engine.read) plus the total main-thread long-task time the PerformanceObserver
// sees across the gesture.
//
// VERDICT LOGIC: lateStepsDropped climbing + a pile of long-tasks during the drag
// CONFIRMS that SvelteFlow node-drag render cost starves the main-thread clock —
// i.e. the real fix is UI-render perf (Fix #2), not the audio architecture. If it
// stays ~0 here too, the symptom is elsewhere (heavier real patches / video).
// The console.log line is the deliverable.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const SEQ_BPM = 120;
const DRAG_MS = 2000;
const FANOUT = 14; // cables off the dragged sequencer (clock fan-out)

async function readClock(page: Page, id: string) {
  return await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[nodeId];
    const rd = (k: string) => {
      if (!eng || !node) return -1;
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : 0;
    };
    return { late: rd('lateStepsDropped'), pastDue: rd('pastDueEmits'), adv: rd('totalAdvances'), t: performance.now() };
  }, id);
}

test('perf-node-drag: dragging a heavily-cabled running clock module', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Sequencer (the clock) fanning its gate out to FANOUT adsr sinks → the
  // dragged node owns many cables, the worst case for edge-path recompute.
  const nodes: Array<{ id: string; type: string; params?: Record<string, number> }> = [
    { id: 'seq', type: 'sequencer', params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 } },
  ];
  for (let i = 0; i < FANOUT; i++) nodes.push({ id: `adsr${i}`, type: 'adsr' });
  const edges = Array.from({ length: FANOUT }, (_, i) => ({ from: 'seq', fromPort: 'gate', to: `adsr${i}`, toPort: 'gate' }));

  await spawnPatch(page, nodes, edges).catch(() => spawnPatch(page, nodes, []));

  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes['seq'];
      if (!eng || !node) return false;
      const v = eng.read(node, 'totalAdvances');
      return typeof v === 'number' && v > 0;
    },
    undefined,
    { timeout: 8000 },
  );

  // Install the long-task observer BEFORE the drag; stash on window so we can
  // read what it accumulated during the Playwright-driven gesture.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __ndrag?: { ms: number; n: number; po?: PerformanceObserver } };
    w.__ndrag = { ms: 0, n: 0 };
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { w.__ndrag!.ms += e.duration; w.__ndrag!.n++; }
      });
      po.observe({ entryTypes: ['longtask'] });
      w.__ndrag.po = po;
    } catch { /* longtask unsupported */ }
  });

  const before = await readClock(page, 'seq');

  // Real-mouse drag of the sequencer node's title bar (draggable area), a
  // sustained zig-zag for ~DRAG_MS — this is a genuine SvelteFlow node drag.
  const box = await page.locator('[data-id="seq"]').boundingBox();
  if (!box) throw new Error('could not locate sequencer node');
  const cx = box.x + box.width / 2;
  const cy = box.y + 10; // title bar, above any control
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < DRAG_MS) {
    const dx = 60 * Math.sin(k * 0.35);
    const dy = 40 * Math.cos(k * 0.5);
    await page.mouse.move(cx + dx, cy + dy, { steps: 2 });
    k++;
  }
  await page.mouse.up();

  const after = await readClock(page, 'seq');
  const longTask = await page.evaluate(() => {
    const w = globalThis as unknown as { __ndrag?: { ms: number; n: number; po?: PerformanceObserver } };
    w.__ndrag?.po?.disconnect();
    return { ms: w.__ndrag?.ms ?? 0, n: w.__ndrag?.n ?? 0 };
  });

  const lateDelta = after.late - before.late;
  const pastDueDelta = after.pastDue - before.pastDue;
  const tempoDelta = after.adv - before.adv;
  const windowMs = after.t - before.t;
  const expectedAdvances = (windowMs / 1000 + 0.2) / (60 / SEQ_BPM / 4);

  // eslint-disable-next-line no-console
  console.log(
    `[perf-node-drag] fanout=${FANOUT}cables mouseMoves=${k} window=${windowMs.toFixed(0)}ms | ` +
      `CLOCK: tempoDelta=${tempoDelta} (expected~${expectedAdvances.toFixed(1)}) ` +
      `lateStepsDropped+=${lateDelta} pastDueEmits+=${pastDueDelta} | ` +
      `longTasks=${longTask.n} totalLongTaskMs=${longTask.ms.toFixed(0)} ` +
      `(${((longTask.ms / windowMs) * 100).toFixed(0)}% of window)`,
  );

  // Sanity: the drag actually moved the mouse a lot.
  expect(k, 'drag loop barely ran').toBeGreaterThan(20);
  // Measurement assertions (the hypothesis under test). If the node-drag render
  // cost starves the main-thread clock, lateStepsDropped climbs here.
  expect(pastDueDelta, 'pastDueEmits climbed during node drag — clock bunched onto "now"').toBe(0);
  expect(lateDelta, 'lateStepsDropped climbed during node drag — SvelteFlow render starved the clock lookahead').toBeLessThanOrEqual(3);
});
