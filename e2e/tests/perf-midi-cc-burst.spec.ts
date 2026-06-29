// e2e/tests/perf-midi-cc-burst.spec.ts
//
// MEASUREMENT #1 from the timing-architecture adversarial review
// (.myrobots/plans/clock-arch-adversarial-review). The load-bearing claim of
// the review's weakness #2 — "twisting a couple of mapped MIDI knobs floods the
// live Yjs doc UNCOALESCED (each CC = one transact + O(N+E) snapshot rebuild +
// reconcile), starving the clock" — is PROVEN as a write-storm but its AUDIBLE
// tempo effect was UNMEASURED. The review explicitly warned: the repo's own
// perf-tempo-under-modulation spec shows the worker tick keeps tempo stable
// under a 240 Hz burst ON A SMALL GRAPH, so the danger (if any) is graph-size
// dependent. So: measure on a LARGE graph before committing to the fix.
//
// WHAT THIS MEASURES (it does NOT go through Web MIDI — no fake-MIDIAccess
// injection in e2e). It reproduces the EXACT write the MIDI-CC path makes: a
// direct, UNCOALESCED `__patch.nodes[id].params[k] = v` SyncedStore write (what
// midi-learn's setter `onchange` → setNodeParam does), at a high rate, on TWO
// params ("two knobs"), concurrent with a running internal-clock sequencer on a
// deliberately LARGE patch. We sample the sequencer's clock-health counters
// (`lateStepsDropped`, `pastDueEmits` — already exposed via engine.read) plus
// the Yjs update count and the total main-thread long-task time across the
// burst.
//
// VERDICT LOGIC: if `lateStepsDropped`/`pastDueEmits` stay ~0 on a large graph,
// weakness #2's audible effect is REFUTED at this scale and the coalescing
// rewrite (which costs a rewrite of the synchronous midi-learn test contract)
// is unjustified by evidence. If they climb, the fix is justified — and this
// spec becomes its regression lock. The thresholds below are deliberately
// generous; the console.log line is the actual deliverable for the owner.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const SEQ_BPM = 120;
const BURST_MS = 2000;
// "Large" graph: a chain of VCAs (each a node with a `base` param + a cv input)
// so N + E is big enough that one O(N+E) snapshot rebuild is non-trivial — the
// review's crux is whether per-write snapshot cost scales the storm into clock
// starvation. ~24 nodes + ~23 edges ≈ the "glitches get riches" demo's scale.
const LARGE_N = 24;

interface BurstResult {
  writes: number;
  commits: number;
  advancesBefore: number;
  advancesAfter: number;
  lateBefore: number;
  lateAfter: number;
  pastDueBefore: number;
  pastDueAfter: number;
  windowMs: number;
  longTaskMs: number;
  longTaskCount: number;
}

async function ccBurst(page: Page, seqNodeId: string, knobIds: string[], durationMs: number): Promise<BurstResult> {
  return await page.evaluate(
    async ({ seqNodeId, knobIds, durationMs }) => {
      const w = globalThis as unknown as {
        __ydoc?: { on: (e: string, cb: () => void) => void; off: (e: string, cb: () => void) => void };
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, key: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> } | undefined> };
      };
      const readNum = (id: string, key: string): number => {
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node) return -1;
        const v = eng.read(node, key);
        return typeof v === 'number' ? v : 0;
      };

      let commits = 0;
      const onUpdate = () => { commits++; };
      w.__ydoc?.on('update', onUpdate);

      // Capture main-thread long tasks (>50ms) across the burst — the direct
      // evidence of clock-starving contention.
      let longTaskMs = 0;
      let longTaskCount = 0;
      let po: PerformanceObserver | null = null;
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) { longTaskMs += e.duration; longTaskCount++; }
        });
        po.observe({ entryTypes: ['longtask'] });
      } catch { /* longtask unsupported — longTaskMs stays 0 */ }

      const advancesBefore = readNum(seqNodeId, 'totalAdvances');
      const lateBefore = readNum(seqNodeId, 'lateStepsDropped');
      const pastDueBefore = readNum(seqNodeId, 'pastDueEmits');

      const start = performance.now();
      let writes = 0;
      let i = 0;
      while (performance.now() - start < durationMs) {
        // The EXACT uncoalesced write the MIDI-CC setter makes (setNodeParam =
        // a SyncedStore params assignment → one ydoc transact). Two knobs.
        const v = 0.5 + 0.45 * Math.sin(i * 0.07);
        for (const id of knobIds) {
          const node = w.__patch.nodes[id];
          if (node?.params) { node.params['base'] = v; writes++; }
        }
        i++;
        // Yield every 4 iterations so the page can run rAF + the worker tick
        // callbacks — we're measuring per-write contention, not freezing the page.
        if (i % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
      }
      const windowMs = performance.now() - start;
      const advancesAfter = readNum(seqNodeId, 'totalAdvances');
      const lateAfter = readNum(seqNodeId, 'lateStepsDropped');
      const pastDueAfter = readNum(seqNodeId, 'pastDueEmits');
      w.__ydoc?.off('update', onUpdate);
      po?.disconnect();
      return {
        writes, commits, advancesBefore, advancesAfter,
        lateBefore, lateAfter, pastDueBefore, pastDueAfter,
        windowMs, longTaskMs, longTaskCount,
      };
    },
    { seqNodeId, knobIds, durationMs },
  );
}

test('perf-midi-cc-burst: uncoalesced param storm on a LARGE graph does not starve the clock', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Build a large patch: a running sequencer + a long VCA chain (lots of
  // nodes + edges so the O(N+E) snapshot rebuild per write is expensive).
  const nodes: Array<{ id: string; type: string; params?: Record<string, number> }> = [
    { id: 'seq', type: 'sequencer', params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 } },
  ];
  for (let i = 0; i < LARGE_N; i++) nodes.push({ id: `vca${i}`, type: 'vca', params: { base: 0.5, cvAmount: 1 } });
  const edges: Array<{ from: string; fromPort: string; to: string; toPort: string }> = [];
  for (let i = 0; i < LARGE_N - 1; i++) {
    edges.push({ from: `vca${i}`, fromPort: 'out', to: `vca${i + 1}`, toPort: 'in' });
  }

  await spawnPatch(page, nodes, edges).catch(() => spawnPatch(page, nodes, []));

  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, key: string) => unknown } | null;
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

  const r = await ccBurst(page, 'seq', ['vca0', 'vca1'], BURST_MS);

  const tempoDelta = r.advancesAfter - r.advancesBefore;
  const lateDelta = r.lateAfter - r.lateBefore;
  const pastDueDelta = r.pastDueAfter - r.pastDueBefore;
  const writesPerSec = (r.writes / Math.max(1, r.windowMs)) * 1000;
  const windowS = r.windowMs / 1000;
  const expectedAdvances = (windowS + 0.2) / (60 / SEQ_BPM / 4);

  // THE DELIVERABLE: the measured numbers for the owner's go/no-go on the fix.
  // eslint-disable-next-line no-console
  console.log(
    `[perf-midi-cc-burst] graph=${LARGE_N + 1}nodes/${edges.length}edges ` +
      `window=${r.windowMs.toFixed(0)}ms writes=${r.writes} (${writesPerSec.toFixed(0)}/s) ` +
      `commits=${r.commits} | CLOCK: tempoDelta=${tempoDelta} (expected~${expectedAdvances.toFixed(1)}) ` +
      `lateStepsDropped+=${lateDelta} pastDueEmits+=${pastDueDelta} | ` +
      `longTasks=${r.longTaskCount} totalLongTaskMs=${r.longTaskMs.toFixed(0)}`,
  );

  // Sanity: the storm actually ran.
  expect(r.writes, 'no writes dispatched — storm did not run').toBeGreaterThan(100);

  // VERDICT ASSERTIONS (the hypothesis to falsify). pastDueEmits is the #224/#229
  // regression canary: it MUST stay 0 (Web Audio clamping past-due events onto
  // "now" = the audible bunch). lateStepsDropped is the graceful-degrade counter:
  // a few under a 2s storm is tolerable, a flood means the storm starved the clock.
  expect(pastDueDelta, 'pastDueEmits climbed — the storm bunched the clock onto "now"').toBe(0);
  expect(lateDelta, 'lateStepsDropped flooded — the uncoalesced storm starved the clock lookahead').toBeLessThanOrEqual(2);
  // And the sequencer kept advancing roughly in tempo.
  expect(tempoDelta).toBeGreaterThanOrEqual(Math.floor(expectedAdvances) - 3);
});
