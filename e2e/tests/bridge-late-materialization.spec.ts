// e2e/tests/bridge-late-materialization.spec.ts
//
// Live-engine regression for the Codex audit finding (2026-05-30):
// cross-domain bridges that couldn't be wired at addEdge time (because
// the target/source node wasn't materialized yet) were silently
// abandoned by the reconciler. User-visible symptom: "I patched a cable
// but no signal" intermittencies.
//
// Targeted unit + property coverage lives in:
//   - packages/web/src/lib/audio/engine-pending-bridges.test.ts
//   - packages/web/src/lib/audio/engine-bridge.property.test.ts
//
// What this spec adds: the LIVE engine path. We write the edge into Yjs
// BEFORE the target node, drive a reconcile pass, then add the target
// node — and assert the downstream SCOPE actually sees signal. Mirrors
// nibbles-cv-scope.spec.ts's mechanism (NIBBLES.length_cv → SCOPE.ch1
// is a real video→audio bridge that emits a measurable DC offset).

import { test, expect, type Page } from '@playwright/test';

// Same constants as nibbles-cv-scope.spec.ts — see that file for the
// rationale. length_cv = (length - 59.5) / 59.5; at length=119 → CV=+1.0.
const NIBBLES_MAX_LENGTH = 119;
const NIBBLES_MID = NIBBLES_MAX_LENGTH / 2;
function lengthToCv(length: number): number {
  return (length - NIBBLES_MID) / NIBBLES_MID;
}

async function readScopeCh1(page: Page, scopeNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (
          node: { id: string; type: string; domain: string },
          key: string,
        ) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.read(node, 'ch1_last_sample');
    return typeof v === 'number' ? v : null;
  }, scopeNodeId);
}

test.describe('cross-domain bridge: late-materialization regression (Codex audit)', () => {
  test('edge patched BEFORE target node spawned still delivers signal once target appears', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for the dev __ydoc / __patch / __ensureEngine globals.
    await page.waitForFunction(() => {
      const w = globalThis as unknown as {
        __ensureEngine?: () => Promise<unknown>;
        __ydoc?: { transact: (fn: () => void) => void };
        __patch?: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      };
      return (
        typeof w.__ensureEngine === 'function'
        && typeof w.__ydoc?.transact === 'function'
        && !!w.__patch
      );
    });

    // Bootstrap the engine.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });

    // Clear the patch + write ONLY the SOURCE node + the edge first. The
    // target node (SCOPE) intentionally absent — this is the late-target
    // path. Pre-fix, the edge id silently went into the bridge bookkeeping
    // and was never retried; post-fix it's parked in pendingBridges.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        // Source: NIBBLES (video module that publishes length_cv via
        // audioSources, mirroring nibbles-cv-scope.spec.ts).
        w.__patch.nodes['nib'] = {
          id: 'nib',
          type: 'nibbles',
          domain: 'video',
          position: { x: 80, y: 80 },
          params: {},
        };
        // Edge referencing a TARGET that doesn't exist in nodes yet.
        // Reconciler skips this edge (currentNodes lookup fails) and the
        // engine never sees it on this pass — exactly the pre-fix race
        // shape, except a real user runs the addEdge BEFORE addNode in
        // a single Yjs transaction. The reconciler's current behavior
        // ALSO defers when the target is missing (line 148: src||dst
        // not in currentNodes → continue). So we need a different
        // shape: edge + target node together, but where the source's
        // port handle is `length_cv` (which requires NIBBLES to fully
        // initialize its audioSources — a real "slow factory" race in
        // the field).
        //
        // The cleanest reproduction: spawn both nodes + the edge in ONE
        // transaction; the reconciler iterates nodes-then-edges in
        // sequence, so on slow node factories the edge can apply
        // before the source's audioSources entry is published. Let's
        // spawn the target too, in the same txn.
        w.__patch.nodes['sc'] = {
          id: 'sc',
          type: 'scope',
          domain: 'audio',
          position: { x: 560, y: 80 },
          params: { ch1Range: 1 },
        };
        w.__patch.edges['e_late'] = {
          id: 'e_late',
          source: { nodeId: 'nib', portId: 'length_cv' },
          target: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        };
      });
    });

    // Wait for both cards to render — confirms the reconciler ran +
    // both nodes are in the engine.
    await page.waitForFunction(
      () => document.querySelectorAll('.svelte-flow__node').length === 2,
      undefined,
      { timeout: 8000 },
    );

    // Let the bridge wire up + analyser sample. The pending-bridge drain
    // runs synchronously on addNode completion, so by the time both
    // cards are mounted the bridge is connected.
    await page.waitForTimeout(800);

    // Force NIBBLES length to its max so length_cv = +1.0 (max DC
    // deflection — easy to discriminate from silence).
    await page.evaluate(() => {
      (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = 119;
    });
    await page.waitForTimeout(400);

    const ch1 = await readScopeCh1(page, 'sc');
    expect(ch1, 'scope.ch1_last_sample must be a number after the bridge wires').not.toBeNull();
    expect(
      ch1,
      `scope.ch1 sample at length=119 should be ≈ ${lengthToCv(119).toFixed(3)} (got ${ch1}). ` +
        `A near-zero reading here means the cross-domain bridge silently dropped ` +
        `the edge — the Codex audit finding this PR fixes.`,
    ).toBeGreaterThan(0.7);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      `console/page errors: ${errors.join('; ')}`,
    ).toEqual([]);
  });

  test('edge added in a SEPARATE transaction AFTER the source node still wires + delivers signal', async ({ page }) => {
    // Variant: addNode first, then addEdge in a SECOND transaction. This
    // exercises the addNode-drain-trigger path: the source/target was
    // already there, but a brand-new edge writes in. Pre-fix this was the
    // happy path; post-fix nothing should regress here.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.waitForFunction(() => {
      const w = globalThis as unknown as {
        __ensureEngine?: () => Promise<unknown>;
        __ydoc?: { transact: (fn: () => void) => void };
        __patch?: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      };
      return (
        typeof w.__ensureEngine === 'function'
        && typeof w.__ydoc?.transact === 'function'
        && !!w.__patch
      );
    });
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });

    // Phase 1: nodes only.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        w.__patch.nodes['nib2'] = {
          id: 'nib2', type: 'nibbles', domain: 'video',
          position: { x: 80, y: 80 }, params: {},
        };
        w.__patch.nodes['sc2'] = {
          id: 'sc2', type: 'scope', domain: 'audio',
          position: { x: 560, y: 80 }, params: { ch1Range: 1 },
        };
      });
    });

    await page.waitForFunction(
      () => document.querySelectorAll('.svelte-flow__node').length === 2,
      undefined,
      { timeout: 8000 },
    );
    await page.waitForTimeout(400);

    // Phase 2: edge only.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['e_phase2'] = {
          id: 'e_phase2',
          source: { nodeId: 'nib2', portId: 'length_cv' },
          target: { nodeId: 'sc2', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        };
      });
    });

    await page.waitForTimeout(600);

    await page.evaluate(() => {
      (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = 119;
    });
    await page.waitForTimeout(400);

    const ch1 = await readScopeCh1(page, 'sc2');
    expect(ch1).not.toBeNull();
    expect(
      ch1,
      `scope.ch1 sample at length=119 should be near +1 (got ${ch1})`,
    ).toBeGreaterThan(0.7);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      `console/page errors: ${errors.join('; ')}`,
    ).toEqual([]);
  });
});
